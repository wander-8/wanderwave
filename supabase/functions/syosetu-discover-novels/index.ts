import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// GitHub Actions auto-deployment pipeline enabled
// 小説家になろう API: https://dev.syosetu.com/man/api/
// 最も人気・最新の小説を取得。フリー API なので制限あり（30件/1リクエスト）
const SYOSETU_API = "https://api.syosetu.com/novelapi/api/";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syosetuFetch(params: Record<string, string>) {
  const url = new URL(SYOSETU_API);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Wander-Wave/1.0 (Anime Discovery Bot)"
      }
    });
    if (res.ok) {
      const text = await res.text();
      console.log("Syosetu fetch success, length:", text.length);
      return text;
    }
    console.error("Syosetu HTTP error:", res.status, res.statusText);
    return null;
  } catch (e) {
    console.error("Syosetu fetch error:", e.message);
    return null;
  }
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[　\s]+/g, " ")
    .trim();
}

async function selectAllRows(client: any, table: string, fields: string) {
  const { data, error } = await client.from(table).select(fields);
  if (error) throw error;
  return data || [];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { genre = "romance", limit = 100, dry_run = false, pages = [1] } = await req.json().catch(() => ({}));

  try {
    // Load existing titles once at start (O(1) lookup instead of O(n) per-row scan)
    console.log("Loading existing titles...");
    const { data: existingRecords, error: fetchErr } = await supabase
      .from("movies")
      .select("title")
      .eq("media_type", "novel");
    if (fetchErr) throw fetchErr;

    const existingTitles = new Set(
      (existingRecords || []).map((r: any) => normalizeTitle(r.title))
    );
    console.log(`Loaded ${existingTitles.size} existing novel titles`);

    const candidates: any[] = [];

    // ジャンルマッピング
    // gensou=ファンタジー, romance=恋愛, mystery=ミステリー, etc.
    const genreMap: Record<string, number> = {
      romance: 1, // 恋愛
      fantasy: 2, // ファンタジー
      mystery: 3, // ミステリー
      sf: 4, // SF
      horror: 5, // ホラー
      action: 6, // 冒険
      modern: 8, // 現代ドラマ
    };

    const genreCode = genreMap[genre] || 0;

    // 各ページから小説を取得
    for (const page of pages) {
      const params: Record<string, string> = {
        out: "json", // Syosetu API uses 'out' not 'output'
        lim: "30", // Also 'lim' not 'limit'
        st: page === 1 ? "1" : String((page - 1) * 30 + 1),
        ...(genreCode && { gensou: String(genreCode) }), // 'gensou' is genre param
      };

      console.log("Syosetu request:", { page, params, genreCode, genre });
      const result = await syosetuFetch(params);
      console.log("Syosetu response:", result?.substring(0, 200));

      if (result) {
        try {
          const data = JSON.parse(result);
          if (Array.isArray(data)) {
            const novels = data.filter((item: any) => item?.ncode);
            console.log(`Page ${page}: found ${novels.length} novels`);
            candidates.push(...novels);
          }
        } catch (e) {
          console.error("Syosetu parse error:", e.message, "Input:", result?.substring(0, 200));
        }
      } else {
        console.warn(`Syosetu API returned null for page ${page}`);
      }

      await sleep(100);
    }

    // Filter to fresh candidates only (using pre-cached titles)
    const fresh = candidates.filter((c: any) => {
      if (!c.title) return false;
      return !existingTitles.has(normalizeTitle(c.title));
    });

    // 詳細情報を組み立て
    const rows: any[] = [];
    const skipped: any[] = [];

    for (const item of fresh.slice(0, limit || 100)) {
      const title = item.title?.trim();
      if (!title) {
        skipped.push({ ncode: item.ncode, reason: "no_title" });
        continue;
      }

      const release_year = item.general_firstup ? parseInt(String(item.general_firstup).slice(0, 4), 10) : null;

      rows.push({
        title,
        release_year,
        media_type: "novel",
        tags: ["ライトノベル", "Web小説"],
        intensity: 15, // default
        description: item.story || null,
        poster_url: item.novel_type === "t" ? "https://placeholder-light-novel.com" : null,
        external_ids: { syosetu_ncode: item.ncode },
        source: "syosetu",
        language: "ja",
      });
    }

    if (!dry_run && rows.length > 0) {
      const { error: insertErr } = await supabase.from("movies").insert(rows);
      if (insertErr) throw insertErr;
    }

    return new Response(
      JSON.stringify({
        dry_run,
        genre,
        candidates_fetched: candidates.length,
        duplicates_skipped: fresh.length > 0 ? candidates.length - fresh.length : 0,
        would_insert: rows.length,
        inserted: !dry_run && rows.length > 0 ? rows.length : 0,
        rows: rows.slice(0, 5),
        _debug: {
          existingTitlesCount: existingTitles.size,
          genreCode,
          pagesRequested: pages,
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

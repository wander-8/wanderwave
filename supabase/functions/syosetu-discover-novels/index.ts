import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// GitHub Actions auto-deployment pipeline enabled
// 小説家になろう API: https://dev.syosetu.com/man/api/
// 最も人気・最新の小説を取得。フリー API なので制限あり（30件/1リクエスト）
const SYOSETU_API = "https://api.syosetu.com/novels/1_0/api/";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syosetuFetch(params: Record<string, string>) {
  const url = new URL(SYOSETU_API);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.text();
      if (res.status === 429) {
        await sleep(2000);
        continue;
      }
      return null;
    } catch {
      await sleep(1000 * (attempt + 1));
    }
  }
  return null;
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
    // 既存の小説を dedup 用に取得
    const existingRows = await selectAllRows(supabase, "movies", "title, release_year, media_type");
    const existingKeys = new Set(
      existingRows.map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}|novel`),
    );

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
        gensou: "true",
        output: "json",
        limit: "30", // Syosetu free API の最大値
        st: page === 1 ? "1" : String((page - 1) * 30 + 1), // start number
        ...(genreCode && { genre: String(genreCode) }),
      };

      const result = await syosetuFetch(params);
      if (result) {
        try {
          const data = JSON.parse(result);
          if (Array.isArray(data)) {
            candidates.push(...data);
          }
        } catch (e) {
          console.error("Failed to parse Syosetu response:", e);
        }
      }

      await sleep(1000); // Syosetu のレート制限
    }

    // 既存作品との重複を除外
    const fresh = candidates.filter((c: any) => {
      if (!c.title || !c.general_firstup) return false;

      const year = c.general_firstup ? parseInt(String(c.general_firstup).slice(0, 4), 10) : null;
      const key = `${normalizeTitle(c.title)}|${year}|novel`;

      return !existingKeys.has(key);
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
        rows: rows.slice(0, 10), // Preview of first 10
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

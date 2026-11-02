import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Supabase Edge Functions auto-deployment enabled
// Jikan API v4: https://jikan.moe/ (MyAnimeList の非公式 API)
// 無料、認証不要、アニメのメタデータを豊富に提供
const JIKAN_API = "https://api.jikan.moe/v4";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jikanFetch(endpoint: string, params: Record<string, string> = {}) {
  const url = new URL(`${JIKAN_API}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.json();
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

function mapGenreToTag(genre: string): string[] {
  const mapping: Record<string, string[]> = {
    action: ["アクション", "ドキドキ"],
    adventure: ["冒険", "ワクワク"],
    comedy: ["コメディ", "楽しい"],
    drama: ["ドラマ", "感動"],
    fantasy: ["ファンタジー", "ワクワク"],
    horror: ["ホラー", "怖い"],
    mystery: ["ミステリー", "考えさせられる"],
    psychological: ["サイコ", "考えさせられる"],
    romance: ["恋愛", "ドキドキ"],
    "sci-fi": ["SF", "考えさせられる"],
    supernatural: ["超自然", "怖い"],
    thriller: ["スリル", "ドキドキ"],
  };
  return mapping[genre.toLowerCase()] || ["アニメ"];
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const {
    order_by = "score", // score, airing_date, members
    status = "airing", // all, airing, complete, upcoming
    limit = 100,
    dry_run = false,
    pages = [1],
  } = await req.json().catch(() => ({}));

  try {
    // 既存のアニメを dedup 用に取得（anime のみ、title と year のみ）
    const { data: existingRows, error: fetchErr } = await supabase
      .from("movies")
      .select("title, release_year")
      .eq("media_type", "anime");
    if (fetchErr) throw fetchErr;

    const existingKeys = new Set(
      (existingRows || []).map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}|anime`),
    );
    // mal_id は別の方法で確認（今回は簡略化）
    const existingMalIds = new Set();

    const candidates: any[] = [];

    // 各ページからアニメを取得
    for (const page of pages) {
      const params: Record<string, string> = {
        page: String(page),
        limit: "25", // Jikan の推奨値
        order_by: order_by,
        sort: "desc",
      };

      if (status !== "all") {
        params.status = status;
      }

      const result = await jikanFetch("/anime", params);
      if (result?.data && Array.isArray(result.data)) {
        candidates.push(...result.data);
      }

      await sleep(500); // Jikan のレート制限対応
    }

    // 既存作品との重複を除外
    const fresh = candidates.filter((c: any) => {
      if (!c.title || existingMalIds.has(c.mal_id)) return false;

      const year = c.aired?.from ? parseInt(String(c.aired.from).slice(0, 4), 10) : null;
      const key = `${normalizeTitle(c.title)}|${year}|anime`;

      return !existingKeys.has(key);
    });

    // 詳細情報を組み立て
    const rows: any[] = [];
    const skipped: any[] = [];

    for (const item of fresh.slice(0, limit || 100)) {
      const title = item.title?.trim() || item.title_japanese?.trim();
      if (!title) {
        skipped.push({ mal_id: item.mal_id, reason: "no_title" });
        continue;
      }

      const release_year = item.aired?.from ? parseInt(String(item.aired.from).slice(0, 4), 10) : null;

      // ジャンルをタグに変換
      const tags = item.genres
        ?.slice(0, 3)
        .flatMap((g: any) => mapGenreToTag(g.name))
        .filter((v: string, i: number, a: string[]) => a.indexOf(v) === i) // 重複削除
        || ["アニメ"];

      // スコアから intensity を推定
      const score = item.score || 5;
      let intensity = Math.round((score / 10) * 50); // 5.0 = 25, 8.0 = 40

      rows.push({
        title,
        release_year,
        media_type: "anime",
        tags,
        intensity,
        description: item.synopsis || null,
        poster_url: item.images?.jpg?.image_url || null,
        external_ids: { mal_id: item.mal_id },
        source: "myanimelist",
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
        order_by,
        status,
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// rakuten-discover-novelで絵本・新書を一律の国/ジャンルで取り込んでいた期間の
// 既存行(絵本=country一律"日本"、新書=genre一律["新書"])を、今の正しい判定
// ロジックで作り直す。ISBNを保存していなかったので、movie_expression_estimates
// のsource文字列(rakuten_novel_batch(...):...;isbn=XXXX)から復元する
// (rakuten-novel-cleanupと同じ手口)。タイトル+ISBNで楽天に再検索し、
// 見つかったbooksGenreIdから国/ジャンルを計算し直してUPDATEする。
// 1回の呼び出しで全件は終わらない(楽天APIのレート制限・実行時間の都合)ため、
// after_id/limitでページングし、呼び出し側が複数回叩く想定。

const FOREIGN_BOOK_GENRE_CODES = ["001003003002", "001003001002"]; // 絵本(外国)・児童書(外国)
function rawGenreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").filter(Boolean);
}
function isForeignBook(booksGenreId: string | null | undefined): boolean {
  const segs = rawGenreSegments(booksGenreId);
  return FOREIGN_BOOK_GENRE_CODES.some((code) => segs.some((s) => s.startsWith(code)));
}

const SHINSHO_EXCLUDED_SUBGENRES = new Set(["001020003", "001020004"]);
const SHINSHO_SUBGENRE_NAMES: Record<string, string> = {
  "001020001": "小説・エッセイ",
  "001020002": "暮らし・健康・料理",
  "001020005": "語学・学習参考書",
  "001020006": "旅行・留学・アウトドア",
  "001020007": "人文・思想・社会",
  "001020008": "ビジネス・経済・就職",
  "001020009": "パソコン・システム開発",
  "001020010": "科学・医学・技術",
  "001020011": "エンタメ",
};
const SHINSHO_SUBGENRE_TAGS: Record<string, string[]> = {
  "001020001": ["考えさせられる", "感動"],
  "001020002": ["リラックス", "楽しい"],
  "001020005": ["考えさせられる"],
  "001020006": ["ワクワク", "美しい"],
  "001020007": ["考えさせられる"],
  "001020008": ["考えさせられる"],
  "001020009": ["考えさせられる"],
  "001020010": ["考えさせられる", "美しい"],
  "001020011": ["楽しい", "ワクワク"],
};
function genreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").map((s) => s.slice(0, 9)).filter(Boolean);
}
function shinshoInfo(booksGenreId: string | null | undefined): { ja: string; tags: string[]; excluded: boolean } {
  const segs = genreSegments(booksGenreId);
  if (segs.some((s) => SHINSHO_EXCLUDED_SUBGENRES.has(s))) return { ja: "新書", tags: ["考えさせられる"], excluded: true };
  for (const seg of segs) {
    if (SHINSHO_SUBGENRE_NAMES[seg]) return { ja: SHINSHO_SUBGENRE_NAMES[seg], tags: SHINSHO_SUBGENRE_TAGS[seg], excluded: false };
  }
  return { ja: "新書", tags: ["考えさせられる"], excluded: false };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rakutenFetchByTitleAndIsbn(title: string, isbn: string) {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  url.searchParams.set("title", title);
  url.searchParams.set("isbnjan", isbn);
  url.searchParams.set("hits", "10");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") } });
      if (res.ok) return await res.json();
      if (res.status === 429) { await sleep(1200); continue; }
      return null;
    } catch { await sleep(500); }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const { book_type, dry_run = true, after_id = 0, limit = 40 } = await req.json().catch(() => ({}));
    if (book_type !== "絵本" && book_type !== "新書") {
      throw new Error('book_type must be "絵本" or "新書"');
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error: rowsErr } = await supabase
      .from("movies")
      .select("id, title, genre, country")
      .eq("is_novel", true)
      .contains("genre", [book_type])
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (rowsErr) throw rowsErr;

    const { count: totalRemaining } = await supabase
      .from("movies")
      .select("id", { count: "exact", head: true })
      .eq("is_novel", true)
      .contains("genre", [book_type])
      .gt("id", after_id);

    const ids = (rows || []).map((r: any) => r.id);
    const { data: estimates, error: estErr } = await supabase
      .from("movie_expression_estimates")
      .select("movie_id, source")
      .in("movie_id", ids.length ? ids : [-1])
      .like("source", "rakuten_novel_batch%");
    if (estErr) throw estErr;

    const isbnByMovieId = new Map<number, string>();
    (estimates || []).forEach((e: any) => {
      const m = String(e.source).match(/isbn=([0-9Xx]+)/);
      if (m) isbnByMovieId.set(e.movie_id, m[1]);
    });

    const results: any[] = [];
    for (const row of rows || []) {
      const isbn = isbnByMovieId.get(row.id);
      if (!isbn) {
        results.push({ id: row.id, title: row.title, status: "no_isbn_on_record" });
        continue;
      }
      const data: any = await rakutenFetchByTitleAndIsbn(row.title, isbn);
      const items = (data?.Items || []).map((w: any) => w.Item);
      const item = items.find((it: any) => it.isbn === isbn) || null;
      if (!item) {
        results.push({ id: row.id, title: row.title, isbn, status: "not_found" });
        await sleep(250);
        continue;
      }
      if (book_type === "絵本") {
        const newCountry = isForeignBook(item.booksGenreId) ? "海外" : "日本";
        results.push({ id: row.id, title: row.title, before: row.country, after: newCountry, changed: row.country !== newCountry });
        if (!dry_run && row.country !== newCountry) {
          const { error: upErr } = await supabase.from("movies").update({ country: newCountry }).eq("id", row.id);
          if (upErr) throw upErr;
        }
      } else {
        const info = shinshoInfo(item.booksGenreId);
        const newGenre = [info.ja];
        results.push({
          id: row.id, title: row.title, before: row.genre, after: newGenre, tags: info.tags,
          excluded: info.excluded, changed: JSON.stringify(row.genre) !== JSON.stringify(newGenre),
        });
        if (!dry_run && JSON.stringify(row.genre) !== JSON.stringify(newGenre)) {
          const { error: upErr } = await supabase
            .from("movies")
            .update({ genre: newGenre, emotion_tags: info.tags })
            .eq("id", row.id);
          if (upErr) throw upErr;
        }
      }
      await sleep(250);
    }

    const nextAfterId = rows && rows.length ? rows[rows.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        book_type,
        dry_run,
        total_remaining_before_this_batch: totalRemaining,
        after_id,
        next_after_id: nextAfterId,
        batch_size: (rows || []).length,
        done: (rows || []).length < limit,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

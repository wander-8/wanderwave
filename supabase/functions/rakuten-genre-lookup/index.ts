import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const SITE_URL = "https://wander-8.site/";

Deno.serve(async (req: Request) => {
  const { mode = "book", books_genre_id, hits = 10, page = 1, sort = "sales", title, isbn } = await req.json().catch(() => ({}));

  if (mode === "genre") {
    // BooksGenre/Searchは指定したbooksGenreIdの子ジャンル一覧を返す
    // (ジャンルIDが変わった/廃止された場合の現在の正しいIDを確認する用途)。
    const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksGenre/Search/20121128");
    url.searchParams.set("applicationId", RAKUTEN_APP_ID);
    url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
    if (books_genre_id) url.searchParams.set("booksGenreId", books_genre_id);
    const res = await fetch(url.toString(), { headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") } });
    const data = await res.json();
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
  }

  const url = new URL("https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  if (books_genre_id) url.searchParams.set("booksGenreId", books_genre_id);
  if (title) url.searchParams.set("title", title);
  if (isbn) url.searchParams.set("isbnjan", isbn);
  url.searchParams.set("hits", String(hits));
  url.searchParams.set("page", String(page));
  url.searchParams.set("sort", sort);
  const res = await fetch(url.toString(), { headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") } });
  const data = await res.json();
  return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
});

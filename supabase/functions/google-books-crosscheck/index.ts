import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
// 無料のキー無しアクセスは呼び出し元IP単位の共有クォータ(実測で1日の
// 上限が0枠のことがあり、本番で常時429になることを確認済み)。
// GOOGLE_BOOKS_API_KEYが未設定でも動く(常に429で終わるだけ)が、
// 設定すればGoogle Cloud Consoleの無料枠(1日1000リクエスト)が使える。
const GOOGLE_BOOKS_API_KEY = Deno.env.get("GOOGLE_BOOKS_API_KEY") || "";
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// 楽天に依存しすぎている(オーナー指摘:「楽天にリンクを繋げたくない。
// むしろもっといい、ちゃんと拾い上げるべきリンク先に繋げたい。本の
// 追加ソースを足せば楽天の独占を避けられる」)ことへの対策の第一弾。
// 新しい取り込みパイプラインを別に作るのではなく、既存の楽天由来の
// 本データをGoogle Booksで照合・補強する「精査」アプローチを取る
// (オーナー本人の言葉:「他に情報が詰まった他のAPIが出てきたからそっちも
// 取り込んで一緒に稼働させることで、そこから精査すれば情報が盤石に
// なるんじゃないか」)。

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 特典グッズ等のJANコードではなく、本物のISBN(978/979始まりの13桁)を
// 指すかどうか。注意: rakuten-discover-novel側の同名っぽい関数
// isGoodsIsbn()は意味が逆(trueが「本物のISBNではない」)なので、
// ここではあえて名前を変えて混同を防ぐ。
function isRealIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && /^97[89]/.test(isbn);
}

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

async function rakutenFetchByTitle(title: string): Promise<any> {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  url.searchParams.set("title", title);
  url.searchParams.set("hits", "5");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") } });
      if (res.ok) return await res.json();
      if (res.status === 429) { await sleep(1500); continue; }
      if (res.status >= 500) { await sleep(500 * (attempt + 1)); continue; }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// 既存のタイトルだけで登録済みの本(isbn列が無かった頃に入った行)のISBNを、
// タイトルで楽天を再検索して取り戻す。新規ソース(Google Books/NDL)との
// 突き合わせキーがISBNである以上、ここを埋めないと既存カタログの大半は
// クロスチェックの対象にすらならない。
async function recoverIsbn(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title")
    .eq("media_type", "novel")
    .is("isbn", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        const data = await rakutenFetchByTitle(m.title);
        const items = (data?.Items || []).map((w: any) => w.Item);
        // タイトル完全一致(正規化後)を優先。無ければ最有力候補(先頭)を使う。
        const exact = items.find((it: any) => normalizeTitle(it.title) === normalizeTitle(m.title));
        const chosen = exact || items[0];
        const isbn = chosen && isRealIsbn(chosen.isbn) ? chosen.isbn : null;
        if (isbn && write) {
          await supabase.from("movies").update({ isbn }).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, isbn, matched: !!exact };
      }),
    );
    results.push(...chunkResults);
    await sleep(300);
  }
  return results;
}

// ISBNが分かっている本をGoogle Books APIで照合する。キー無しの匿名アクセスは
// 共有クォータが実質0枠で常に429になることを実機確認済みなので、
// GOOGLE_BOOKS_API_KEYの設定が実質必須。descriptionをgoogle_books_synopsisに
// 保存し、楽天側のsynopsisが空/極端に短い場合は本文のsynopsisそのものも
// こちらで補強する。
async function crosscheckGoogleBooks(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, synopsis, isbn")
    .eq("media_type", "novel")
    .not("isbn", "is", null)
    .is("google_books_checked_at", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        let description: string | null = null;
        let found = false;
        try {
          const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}` : "";
          const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(m.isbn)}${keyParam}`);
          if (res.status === 429 || res.status >= 500) {
            // クォータ超過/一時的なAPI障害。「本当に見つからなかった」と
            // 混同するとchecked_atが立って二度と再検索されなくなるため、
            // ここはchecked_atを立てずに次回に回す(GOOGLE_BOOKS_API_KEY未設定の
            // 無料枠はクォータが0〜ごく少数のことがあり、実際に本番で
            // 429が返り続けることを確認済み)。
            return { movie_id: m.id, title: m.title, isbn: m.isbn, found: false, quotaOrServerError: true, status: res.status };
          }
          if (res.ok) {
            const json = await res.json();
            const item = (json.items || [])[0];
            if (item) {
              found = true;
              description = item.volumeInfo?.description || null;
            }
          }
        } catch {
          return { movie_id: m.id, title: m.title, isbn: m.isbn, found: false, networkError: true };
        }

        const synopsisIsThin = !m.synopsis || m.synopsis.trim().length < 20;
        if (write) {
          const update: Record<string, unknown> = {
            google_books_synopsis: description,
            google_books_checked_at: new Date().toISOString(),
          };
          if (description && synopsisIsThin) update.synopsis = description.slice(0, 400);
          await supabase.from("movies").update(update).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, isbn: m.isbn, found, usedAsSynopsis: !!description && synopsisIsThin };
      }),
    );
    results.push(...chunkResults);
    await sleep(200);
  }
  return results;
}

Deno.serve(async (req: Request) => {
  try {
    const { target = "verify", offset = 0, limit = 50, write = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const results = target === "recover_isbn"
      ? await recoverIsbn(supabase, offset, limit, write)
      : await crosscheckGoogleBooks(supabase, offset, limit, write);

    return new Response(JSON.stringify({ target, offset, limit, write, processed: results.length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

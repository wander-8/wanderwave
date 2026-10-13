import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
// 無料のキー無しアクセスは呼び出し元IP単位の共有クォータが実質0枠で、
// 本番で常時429になることを確認済み。GOOGLE_BOOKS_API_KEY(オーナーが
// Google Cloud Consoleで発行、Books APIのみに制限)を設定することで動く。
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
//
// 過去のバグ: 楽天タイトル検索で一致しなかった行には何も書き込んでいな
// かったため、isbn IS NULLのままいつまでもその行がoffset=0の「先頭
// limit件」に居座り続け、2分おきのcronが同じ数十件を何度も再試行する
// だけでその先の行に一切進めなくなっていた(実データで確認: 同じ
// movie_id群がoffset=0への2回の呼び出しで完全に一致して返ってきた)。
// 他のbackfill(tmdb-vote-backfill等)と同じ「試した行は成否に関わらず
// checked_atを立てて窓を進める」パターンに揃える。一時的なネットワーク
// 障害(rakutenFetchByTitleがnullを返す = リトライし尽くして失敗)の
// 場合だけはchecked_atを立てず次回に回す(「本当に見つからなかった」と
// 混同すると二度と再検索されなくなるため)。
async function recoverIsbn(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, amazon_url")
    .eq("media_type", "novel")
    .is("isbn", null)
    .is("isbn_recovery_checked_at", null)
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
        if (data === null) {
          // リトライし尽くしても応答が取れなかった(一時的な障害)。
          // 「見つからなかった」と混同しないよう、checked_atを立てずに
          // 次回のcron実行に回す。
          return { movie_id: m.id, title: m.title, isbn: null, matched: false, transientError: true };
        }
        const items = (data?.Items || []).map((w: any) => w.Item);
        // タイトル完全一致(正規化後)を優先。無ければ最有力候補(先頭)を使う。
        const exact = items.find((it: any) => normalizeTitle(it.title) === normalizeTitle(m.title));
        const chosen = exact || items[0];
        const isbn = chosen && isRealIsbn(chosen.isbn) ? chosen.isbn : null;
        if (write) {
          const update: Record<string, unknown> = { isbn_recovery_checked_at: new Date().toISOString() };
          if (isbn) {
            update.isbn = isbn;
            // 購入先リンク(オーナー方針:「書籍はAmazonや各種元の出版社の
            // 公式サイトを設置する」)。ISBNが分かった時点で一緒に埋める
            // (追加のAPI呼び出し不要な単純な導出のため)。official_url
            // (出版社の本当の公式サイト)とは別の列に入れる(オーナー指摘:
            // 「公式サイト、出版社のものにしてほしい。Amazonとは切り離して」)。
            if (!m.amazon_url) update.amazon_url = `https://www.amazon.co.jp/s?k=${isbn}&i=stripbooks`;
          }
          await supabase.from("movies").update(update).eq("id", m.id);
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
// GOOGLE_BOOKS_API_KEYの設定が実質必須。日本語ISBNでの実機確認では
// ヒット率自体が低く(有名な現代小説でも軒並み該当無し)、書誌情報の
// 補完はNDL Search側に任せる方針にした(オーナー方針:「NDL Searchで
// 国内作品の情報は補完しつつ、Google Books APIは裏方連携」)。ここでは
// 見つかった場合にdescription(あらすじ)とcover(表紙画像)だけを、
// 既存データが無い場合に限って補完する裏方処理に専念する。
async function crosscheckGoogleBooks(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, synopsis, isbn, poster_path")
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
        let coverUrl: string | null = null;
        let found = false;
        let lastStatus: number | null = null;
        const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${encodeURIComponent(GOOGLE_BOOKS_API_KEY)}` : "";
        // Google Booksのisbn:検索は実機確認で1リクエストあたり約7割の確率で
        // 503(backendFailed)を返す、既知の不安定さがある(通常のテキスト
        // 検索は毎回成功することを確認済みなので、ISBN検索エンドポイント
        // 固有の問題)。429(クォータ超過)は即座に諦めて次回に回すが、
        // 503は数回リトライすれば大半は成功するため、ここだけ短い
        // リトライを入れる。
        let ok = false;
        for (let attempt = 0; attempt < 4 && !ok; attempt++) {
          try {
            const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(m.isbn)}${keyParam}`);
            lastStatus = res.status;
            if (res.status === 429) break; // クォータ超過は即座に諦める
            if (res.status >= 500) { await sleep(400 * (attempt + 1)); continue; }
            if (res.ok) {
              const json = await res.json();
              const item = (json.items || [])[0];
              if (item) {
                found = true;
                description = item.volumeInfo?.description || null;
                // サムネイルURLは既定でhttp://なので、index.htmlが混在コンテンツ
                // 扱いで弾かないようhttpsへ揃える。
                const thumb = item.volumeInfo?.imageLinks?.thumbnail || item.volumeInfo?.imageLinks?.smallThumbnail || null;
                coverUrl = thumb ? thumb.replace(/^http:/, "https:") : null;
              }
              ok = true;
            }
          } catch {
            await sleep(400 * (attempt + 1));
          }
        }
        if (!ok) {
          // クォータ超過、またはリトライしても一時的な障害が続いた場合。
          // 「本当に見つからなかった」と混同するとchecked_atが立って
          // 二度と再検索されなくなるため、ここはchecked_atを立てずに
          // 次回のcron実行に回す。
          return { movie_id: m.id, title: m.title, isbn: m.isbn, found: false, quotaOrServerError: true, status: lastStatus };
        }

        const synopsisIsThin = !m.synopsis || m.synopsis.trim().length < 20;
        const coverIsMissing = !m.poster_path;
        if (write) {
          const update: Record<string, unknown> = {
            google_books_synopsis: description,
            google_books_checked_at: new Date().toISOString(),
          };
          if (description && synopsisIsThin) update.synopsis = description.slice(0, 400);
          if (coverUrl && coverIsMissing) update.poster_path = coverUrl;
          await supabase.from("movies").update(update).eq("id", m.id);
        }
        return {
          movie_id: m.id,
          title: m.title,
          isbn: m.isbn,
          found,
          usedAsSynopsis: !!description && synopsisIsThin,
          usedAsCover: !!coverUrl && coverIsMissing,
        };
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

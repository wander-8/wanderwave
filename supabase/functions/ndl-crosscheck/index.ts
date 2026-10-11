import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NDL_SRU_ENDPOINT = "https://ndlsearch.ndl.go.jp/api/sru";

// 国立国会図書館サーチ(NDL Search)で国内作品の書誌情報を補完する。
// APIキー不要・無料、実測でGoogle Booksよりもずっと安定して日本語ISBNが
// ヒットする(同じISBNでGoogle Booksは8割方503/該当無しだったのに対し、
// NDLは正確な書誌(タイトル・著者・出版社・刊行年)を1回で返した)。
// Google Booksは逆にあらすじ・表紙画像の補完用バックグラウンド処理に
// 専念させ(ndl-crosscheckとgoogle-books-crosscheckで役割分担)、ここでは
// director(著者)・release_year(刊行年)が欠けている場合の補完と、
// 将来の表記ゆれ検証用にndl_titleを保存するだけにとどめる(オーナー
// 方針:「NDL Searchで国内作品の情報は補完しつつ、Google Books APIは
// 裏方連携」)。

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unescapeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// NDLのdc:creatorは「杉井光 著」のように末尾に役割表記が付くことが多い。
// directorカラムに他ソース(Rakutenのauthor等)と揃えて保存したいので、
// よくある役割表記だけ取り除く(完全な正規化ではなく既知パターンのみ)。
const CREATOR_ROLE_SUFFIX = /[\s　]*(著|作|編|訳|編著|著者)[\s　]*(\[著\]|；.*|;.*)?$/;
function cleanCreatorName(raw: string): string {
  return raw.replace(CREATOR_ROLE_SUFFIX, "").trim();
}

interface NdlRecord {
  found: boolean;
  title: string | null;
  creator: string | null;
  issuedYear: number | null;
  // 3回リトライしても応答自体が得られなかった場合にtrue。「本当に
  // 該当が無かった」(found:false, transient:false)と区別し、呼び出し元で
  // ndl_checked_atを立てるかどうかを分ける。
  transient: boolean;
}

async function ndlLookupByIsbn(isbn: string): Promise<NdlRecord> {
  const url = new URL(NDL_SRU_ENDPOINT);
  url.searchParams.set("operation", "searchRetrieve");
  url.searchParams.set("version", "1.2");
  // CQLはisbn=9999...のように値を引用符で囲まないと緩い一致になり
  // 無関係なヒットを拾うことがある(実機確認)。必ず引用符付きにする。
  url.searchParams.set("query", `isbn="${isbn}"`);
  url.searchParams.set("recordSchema", "dcndl");
  url.searchParams.set("maximumRecords", "1");

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // NDL側が稀に応答しないまま接続だけ張られ続けることがあり、
      // タイムアウトを付けないと1件のハングでバッチ全体が
      // Edge Functionの実行時間切れまで詰まってしまう(実機で確認)。
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) { await sleep(500 * (attempt + 1)); continue; }
      const bodyRaw = await res.text();
      if (bodyRaw.includes("<diagnostics>") || />0<\/numberOfRecords>/.test(bodyRaw)) {
        return { found: false, title: null, creator: null, issuedYear: null, transient: false };
      }
      const body = unescapeHtmlEntities(bodyRaw);
      const title = body.match(/<dcterms:title>([^<]*)<\/dcterms:title>/)?.[1]?.trim() || null;
      const creatorRaw = body.match(/<dc:creator>([^<]*)<\/dc:creator>/)?.[1]?.trim() || null;
      const creator = creatorRaw ? cleanCreatorName(creatorRaw) : null;
      const issuedRaw = body.match(/<dcterms:issued[^>]*>([^<]*)<\/dcterms:issued>/)?.[1]?.trim() || null;
      const issuedYear = issuedRaw ? parseInt((issuedRaw.match(/[0-9]{4}/) || [])[0] || "", 10) || null : null;
      return { found: !!title, title, creator, issuedYear, transient: false };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  // 3回とも応答が得られなかった場合は一時的な障害として扱い、
  // checked_atを立てずに次回のcron実行に回す。
  return { found: false, title: null, creator: null, issuedYear: null, transient: true };
}

async function crosscheckNdl(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, director, release_year, isbn")
    .eq("media_type", "novel")
    .not("isbn", "is", null)
    .is("ndl_checked_at", null)
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
        const ndl = await ndlLookupByIsbn(m.isbn);
        if (ndl.transient) {
          return { movie_id: m.id, title: m.title, isbn: m.isbn, found: false, transient: true };
        }
        if (write) {
          const update: Record<string, unknown> = { ndl_checked_at: new Date().toISOString() };
          if (ndl.title) update.ndl_title = ndl.title;
          if (ndl.creator && !m.director) update.director = ndl.creator;
          if (ndl.issuedYear && !m.release_year) update.release_year = ndl.issuedYear;
          await supabase.from("movies").update(update).eq("id", m.id);
        }
        return {
          movie_id: m.id,
          title: m.title,
          isbn: m.isbn,
          found: ndl.found,
          ndlTitle: ndl.title,
          filledDirector: !!(ndl.creator && !m.director),
          filledYear: !!(ndl.issuedYear && !m.release_year),
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
    const { offset = 0, limit = 50, write = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const results = await crosscheckNdl(supabase, offset, limit, write);
    return new Response(JSON.stringify({ offset, limit, write, processed: results.length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

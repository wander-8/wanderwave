import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// anilist-discover-mangaを使っていた頃に取り込んだ古い漫画は、AniListの
// 英題・ローマ字題のまま残っているものがある(「Solo Leveling」「Tower of God」
// 等の韓国発ウェブトゥーンは、AniListのnativeが韓国語のため日本語化できない)。
// 一方、楽天ブックスは日本国内で実際に販売されている書誌データベースなので、
// 英題で検索してヒットした商品のタイトルこそが日本市場での正式な表記になる。
// 「ONE PIECE」「BLEACH」のように原作から英字表記が公式タイトルの作品は、
// 楽天で検索してもやはり英字のまま返ってくるため、誤って変な日本語タイトルに
// 書き換えてしまう心配がない(自己検証的な仕組み)。
function looksJapaneseText(s: string): boolean {
  return /[぀-ヿ一-鿿]/.test(s);
}

// コミックカテゴリ配下には、作品本編ではない便乗商品(旅行ガイド・
// 設定資料集など)が紛れ込むことがあるため、そうした候補は無視して次の
// 検索結果に進む(rakuten-discover-mangaと同じブラックリスト)。
const NON_MANGA_TITLE_PATTERNS = [
  "地球の歩き方", "シールブック", "設定資料集", "ぬり絵", "コンプリートガイド", "公式ガイドブック",
];
function isNonMangaTitle(title: string): boolean {
  return NON_MANGA_TITLE_PATTERNS.some((w) => title.includes(w));
}

function stripBonusPrefix(title: string): string {
  const m = title.match(/^.{1,20}付き[\s　]+(.+)$/u);
  return m ? m[1] : title;
}
function stripRetailTags(title: string): string {
  const m = title.match(/^【(バーゲン本|サイン本|楽天ブックス限定特典|特典)】\s*(.+)$/u);
  if (!m) return title.trim();
  const rest = m[2];
  const parenIdx = rest.search(/[\(（]/u);
  return (parenIdx === -1 ? rest : rest.slice(0, parenIdx)).trim();
}
function stripVolumeSuffix(rawTitle: string): string {
  const title = stripRetailTags(stripBonusPrefix(rawTitle));
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  return title.trim();
}

// 「MONSTER 完全版」「SLAM DUNK 新装再編版」のように、同じ作品の別装丁
// (完全版・新装版等)のタイトルは、末尾のこの手の修飾語を取り除いて元の
// 通常版タイトルと同一かどうかを比べたい(「Monster」→"MONSTER 完全版"に
// 書き換えてしまうと不自然なため)。
const EDITION_SUFFIX_PATTERN = /[\s　]*(新装再編版|新装完全版|完全版|新装版|愛蔵版|ワイド版|文庫版|カラー版|総集編|オンデマンド版)+$/u;
function stripEditionSuffix(title: string): string {
  return title.replace(EDITION_SUFFIX_PATTERN, "").trim();
}

// 「GANTZ 文庫版 コミック 全18巻 完結セット」のようなまとめ買いセットSKUは
// 作品名として不自然なため、代表候補として採用しない。
function stripBundleCountSuffix(title: string): string {
  return title
    .replace(/[\s　]*[\(（]?全[0-9０-９]+[巻冊集][\)）]?(セット|箱入り[^\s　]*|完結セット)?\s*$/u, "")
    .replace(/[\s　]*[0-9０-９]+[巻冊][\s　]*セット\s*$/u, "")
    .replace(/[\s　]*[\(（][0-9０-９]+冊[\)）]\s*$/u, "")
    .trim();
}
function isBundleTitle(title: string): boolean {
  return title !== stripBundleCountSuffix(title);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rakutenFetch(params: Record<string, string>) {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") },
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        await sleep(1500);
        continue;
      }
      if (res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      const body = await res.text();
      return { error: true, status: res.status, body };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 20 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title")
      .eq("is_manga", true)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(500);
    if (error) throw error;

    // 取得ウィンドウ内のascii行が多い場合、slice(0,limit)で切り捨てた分を
    // 「処理済み」扱いにして次回スキップしないよう、next_after_idは実際に
    // 処理したascii行の最後のidにする(取得ウィンドウ全体の最後のidにしない)。
    const asciiAll = rows.filter((r: any) => /^[A-Za-z0-9 :'\-.,!?&×]+$/.test(r.title));
    const asciiOnly = asciiAll.slice(0, limit);

    const { data: allTitleRows, error: titleErr } = await supabase.from("movies").select("title");
    if (titleErr) throw titleErr;
    const existingNorm = new Set((allTitleRows || []).map((r: any) => normalizeTitle(r.title)));

    const results: any[] = [];
    for (const r of asciiOnly) {
      // sort=standard(関連度順)を使う。sales(売上順)だとスピンオフや
      // 副読本の方がクエリと無関係に売れていて上位に来ることがあり、
      // 実際に「Monster」→スピンオフ「もうひとつのMONSTER」、「Death Note」→
      // 短編集、のような誤マッチが起きた。関連度順ならクエリと最も文字列が
      // 近い、本編の代表巻が上位に来やすい。
      const data: any = await rakutenFetch({ booksGenreId: "001001", title: r.title, hits: "5", sort: "standard" });
      await sleep(400);
      if (data?.error) {
        results.push({ id: r.id, oldTitle: r.title, error: data.status });
        continue;
      }
      const items = (data?.Items || []).map((w: any) => w.Item);
      let matched: string | null = null;
      for (const item of items) {
        if (isNonMangaTitle(item.title) || isBundleTitle(item.title)) continue;
        const cleaned = stripEditionSuffix(stripVolumeSuffix(item.title));
        if (looksJapaneseText(cleaned)) {
          matched = cleaned;
          break;
        }
      }
      const isCollision = !!matched && matched !== r.title && existingNorm.has(normalizeTitle(matched));
      const willRename = !!matched && matched !== r.title && !isCollision;
      results.push({
        id: r.id,
        oldTitle: r.title,
        candidateNewTitle: matched,
        willRename,
        skipReason: !matched ? "no_japanese_match_found" : matched === r.title ? "already_same" : isCollision ? "collides_with_existing_title" : null,
      });
      if (willRename && !dry_run) {
        const { error: updErr } = await supabase.from("movies").update({ title: matched }).eq("id", r.id);
        if (updErr) throw updErr;
        existingNorm.add(normalizeTitle(matched!));
      }
    }

    const lastCheckedId = asciiOnly.length ? asciiOnly[asciiOnly.length - 1].id : (rows.length ? rows[rows.length - 1].id : after_id);

    return new Response(
      JSON.stringify({
        scanned_rows: rows.length,
        ascii_checked: asciiOnly.length,
        renamed: results.filter((r) => r.willRename).length,
        next_after_id: lastCheckedId,
        exhausted: rows.length < 500,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), { status: 500 });
  }
});

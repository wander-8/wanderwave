import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// 「漫画の巻数が少ないけど推せる名作」棚を作りたい(オーナー要望)が、
// DBには1シリーズ1行(代表巻)しか無く、全巻数を記録していない。楽天を
// title検索で叩き直し、同シリーズ(タイトルをstripVolumeSuffixした結果が
// 完全一致)と判定できた実在書籍(ISBN978/979始まり、グッズ・カレンダー等を
// 除外)の中から一番大きい巻数を拾って概算の巻数として保存する。
// standard/sales両方のソートで検索すると結果の顔ぶれが変わる(片方だけだと
// 「惡の華」のように0件になったり、低めの巻数で頭打ちになったりする実例を
// 確認済み)ため、両方のソートの結果をまとめてから最大値を取る。
// 100巻超級の超長編(ONE PIECE等)は検索結果中の上位30件×2に全巻が
// 載りきらず少なめに出ることがあるが、この棚は「巻数が少ない」方を
// 探すためのものなので、長編が多少過小カウントされても実害は無い
// (元々多いので「少ない」側の閾値には掛からない)。

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
  const withKanjiVolume = title.match(/^(.*?)[\s　]*[\(（]?第[0-9０-９]+[巻冊集][\)）]?\s*$/u);
  if (withKanjiVolume) return withKanjiVolume[1].trim();
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  return title.trim();
}
function extractVolumeNumber(title: string): number {
  const match = title.match(/第([0-9０-９]+)[巻冊集]|[\(（]([0-9]+)[\)）]|[\s　]([0-9]+)\s*$/);
  if (!match) return 0;
  const num = match[1] || match[2] || match[3];
  return num ? parseInt(num, 10) : 0;
}
function isGoodsIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && !/^97[89]/.test(isbn);
}
// シリーズ同一判定のための正規化は、通常のnormalizeTitleより踏み込んで
// 空白を全部除く。DB側に全角スペース入りで保存されているタイトル
// (例:「東京喰種　トーキョーグール」)が、楽天側の表記(空白無し)と
// 空白の有無だけで不一致になり、同シリーズの巻が1件も見つからず
// 「全1巻」に誤判定される実例があったため。
function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase().replace(/[\s　]+/g, "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rakutenSearchTitle(title: string, sort: string) {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  url.searchParams.set("title", title);
  url.searchParams.set("hits", "30");
  url.searchParams.set("sort", sort);
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

async function estimateVolumeCount(seriesTitle: string): Promise<number> {
  const target = normalizeTitle(stripVolumeSuffix(seriesTitle));
  const [standardData, salesData] = await Promise.all([
    rakutenSearchTitle(seriesTitle, "standard"),
    rakutenSearchTitle(seriesTitle, "sales"),
  ]);
  const items = [
    ...((standardData?.Items || []).map((w: any) => w.Item)),
    ...((salesData?.Items || []).map((w: any) => w.Item)),
  ];
  let maxVol = 0;
  let matchCount = 0;
  for (const it of items) {
    if (isGoodsIsbn(it.isbn)) continue;
    if (!it.isbn || !/^97[89]/.test(it.isbn)) continue;
    if (normalizeTitle(stripVolumeSuffix(it.title)) !== target) continue;
    matchCount++;
    const vol = extractVolumeNumber(it.title);
    if (vol > maxVol) maxVol = vol;
  }
  if (maxVol > 0) return maxVol;
  if (matchCount > 0) return matchCount;
  return 1; // 検索に同シリーズの他巻が1件も見つからない場合は、読み切り・全1巻とみなす
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 20 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error: rowsErr } = await supabase
      .from("movies")
      .select("id, title, volume_count")
      .eq("is_manga", true)
      .is("volume_count", null)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (rowsErr) throw rowsErr;

    const { count: totalRemaining } = await supabase
      .from("movies")
      .select("id", { count: "exact", head: true })
      .eq("is_manga", true)
      .is("volume_count", null)
      .gt("id", after_id);

    const results: any[] = [];
    const CONCURRENCY = 4;
    const list = rows || [];
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const chunk = list.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (row: any) => {
        const vol = await estimateVolumeCount(row.title);
        results.push({ id: row.id, title: row.title, volume_count: vol });
        if (!dry_run) {
          const { error: upErr } = await supabase.from("movies").update({ volume_count: vol }).eq("id", row.id);
          if (upErr) throw upErr;
        }
      }));
    }

    const nextAfterId = list.length ? list[list.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        dry_run,
        total_remaining_before_this_batch: totalRemaining,
        after_id,
        next_after_id: nextAfterId,
        batch_size: list.length,
        done: list.length < limit,
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

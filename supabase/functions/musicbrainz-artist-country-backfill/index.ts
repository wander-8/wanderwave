import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 音楽のcountry列は元々「どのiTunesチャートから取り込んだか」をそのまま
// 使っていたため、輸入ヒット曲(日本のPopチャートにMichael Jackson等)が
// 大量に紛れ込んでいた(オーナー指摘:「国別検索の際、明らかに日本の
// 作品じゃないものがたくさん登録されてたりする」「国別検索は、その国ごとの
// アーティストが調べられるようにしたかった」)。MusicBrainz(無料・キー
// 不要、ただし匿名アクセスは1req/秒の厳格な制限)のアーティスト検索APIで
// 実際の出身国(area/country)を取得し、アーティスト単位でartist_country_cache
// に記録してから、そのアーティストの全行のcountryを上書きする。
const MB_BASE = "https://musicbrainz.org/ws/2/artist/";
const USER_AGENT = "WanderWave/1.0 (https://wander-8.site/)";

// MusicBrainzのISO 3166-1 alpha-2国コード→サイト既存の日本語国名表記への
// マッピング。itunes-discover-music側のCOUNTRY_NAME_JA(iTunesストアコード
// 用、小文字)とは別物だが、同じ国名表記に揃える(FILTER_COUNTRIESと一致
// させるため)。
const MB_COUNTRY_TO_JA: Record<string, string> = {
  JP: "日本", US: "アメリカ", GB: "イギリス", KR: "韓国", FR: "フランス", DE: "ドイツ",
  IT: "イタリア", ES: "スペイン", CA: "カナダ", MX: "メキシコ", SE: "スウェーデン", DK: "デンマーク",
  BR: "ブラジル", RU: "ロシア", IE: "アイルランド", NL: "オランダ", PL: "ポーランド", CH: "スイス",
  AR: "アルゼンチン", TR: "トルコ", NO: "ノルウェー", FI: "フィンランド", AT: "オーストリア",
  LU: "ルクセンブルク", RO: "ルーマニア", TW: "台湾", ZA: "南アフリカ", NZ: "ニュージーランド",
  PT: "ポルトガル", IN: "インド", HK: "香港", BE: "ベルギー", AU: "オーストラリア", CN: "中国",
  TH: "タイ", HU: "ハンガリー", CZ: "チェコ", CL: "チリ",
  GR: "ギリシャ", VN: "ベトナム", ID: "インドネシア", SG: "シンガポール", IL: "イスラエル",
  CO: "コロンビア", EG: "エジプト", VE: "ベネズエラ", PE: "ペルー", MY: "マレーシア",
  NG: "ナイジェリア", PH: "フィリピン", AE: "アラブ首長国連邦", SK: "スロバキア",
  SA: "サウジアラビア", UA: "ウクライナ", BG: "ブルガリア", SI: "スロベニア", KZ: "カザフスタン",
  LT: "リトアニア", EE: "エストニア", UZ: "ウズベキスタン", CR: "コスタリカ", LV: "ラトビア",
  BY: "ベラルーシ", AM: "アルメニア", GT: "グアテマラ", MT: "マルタ", LA: "ラオス",
  CY: "キプロス", BN: "ブルネイ", KE: "ケニア", TT: "トリニダード・トバゴ",
  DO: "ドミニカ共和国", LB: "レバノン", HN: "ホンジュラス", JO: "ヨルダン", AZ: "アゼルバイジャン",
  OM: "オマーン", PA: "パナマ", EC: "エクアドル", BH: "バーレーン", PY: "パラグアイ",
  QA: "カタール", KH: "カンボジア", BO: "ボリビア", MD: "モルドバ", NI: "ニカラグア", SV: "エルサルバドル",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// スコア90未満(あいまい一致)は信頼せず「見つからなかった」扱いにする。
// 一般的すぎるアーティスト名(例:「Various Artists」「Unknown」)で
// 無関係な国に誤って上書きする事故を避けるため。
const MIN_SCORE = 90;

async function lookupArtistCountry(artistName: string): Promise<{ country: string | null; score: number | null }> {
  const url = `${MB_BASE}?query=${encodeURIComponent(`artist:"${artistName}"`)}&fmt=json&limit=1`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.status === 503 || res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) return { country: null, score: null };
      const json = await res.json();
      const best = (json.artists || [])[0];
      if (!best) return { country: null, score: null };
      const code = best.country || best.area?.["iso-3166-1-codes"]?.[0] || null;
      const country = code && MB_COUNTRY_TO_JA[code] ? MB_COUNTRY_TO_JA[code] : null;
      return { country, score: best.score ?? null };
    } catch {
      await sleep(800 * (attempt + 1));
    }
  }
  return { country: null, score: null };
}

// PostgRESTはデフォルトで1行取得あたり最大1000件しか返さないため、
// .select()を1回呼ぶだけでは全件取り切れない(音楽director・キャッシュ
// 済みartist_country_cacheのどちらも、件数が増えるほど同じ問題が起きる。
// 実測: director側は本来8,189件のはずが1000件分=3,731件しか出てこな
// かった)。.range()でページングして全件取り切る共通ヘルパーにする。
async function selectAllRows(supabase: any, table: string, column: string, filterFn: (q: any) => any): Promise<string[]> {
  const PAGE_SIZE = 1000;
  const all: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await filterFn(supabase.from(table).select(column)).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data || []).map((r: any) => r[column]).filter(Boolean));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

Deno.serve(async (req: Request) => {
  try {
    const { limit = 50, write = false } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // まだキャッシュに無いアーティスト名を、音楽作品の中から重複無しで
    // limit件だけ取る。director列がアーティスト名(itunes-discover-music参照)。
    const directorRows = await selectAllRows(supabase, "movies", "director", (q) => q.eq("is_music", true).not("director", "is", null));
    const cachedNames = await selectAllRows(supabase, "artist_country_cache", "artist_name", (q) => q);
    const cachedSet = new Set(cachedNames);

    const allArtists = [...new Set(directorRows)];
    const todo = allArtists.filter((a) => !cachedSet.has(a)).slice(0, limit);

    const results: any[] = [];
    for (const artist of todo) {
      const { country, score } = await lookupArtistCountry(artist);
      const accepted = country && score != null && score >= MIN_SCORE;
      results.push({ artist, country, score, accepted });

      if (write) {
        await supabase.from("artist_country_cache").upsert({
          artist_name: artist,
          country: accepted ? country : null,
          mb_score: score,
          checked_at: new Date().toISOString(),
        });
        if (accepted) {
          await supabase.from("movies").update({ country }).eq("director", artist).eq("is_music", true);
        }
      }
      await sleep(1100); // MusicBrainz匿名アクセスの1req/秒制限を守る
    }

    return new Response(
      JSON.stringify({
        write,
        total_artists: allArtists.length,
        already_cached: cachedSet.size,
        remaining_before_this_run: allArtists.length - cachedSet.size,
        processed: results.length,
        accepted: results.filter((r) => r.accepted).length,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err), stack: err?.stack }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

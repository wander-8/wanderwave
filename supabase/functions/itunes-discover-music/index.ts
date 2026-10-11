import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// iTunes(Apple Music)のRSSチャートAPIを使ってアルバムを取り込む。認証不要・
// APIキー不要で叩ける(TMDb/楽天と違い開発者登録が要らない)。
// https://itunes.apple.com/{country}/rss/topalbums/limit={n}/json
// genre_idを指定すると、そのジャンルのランキングに絞れる(未指定なら総合)。
// このAPIは「人気順ランキング」を返すだけで、TMDbのdiscoverのような
// 詳細な絞り込み(年代・投票数等)は無い。1回のリクエストで最大200件まで。
const RSS_BASE = "https://itunes.apple.com";

// e?.category?.attributes?.termに入ってくる実際のジャンル名(iTunes公式の
// 英語表記。日本ストアでも日本語化されずそのまま英語で返ってくる)を、
// サイト共通の気分タグにマッピングする。以前はここのキーを日本語カタカナ
// ("ロック"等)で書いていたため、実データ("Rock"等、常に英語)と一度も
// 一致せず全アルバムがDEFAULT_TAGSの「楽しい」一色になっていた(集計で
// 判明)。ここに無いジャンルはDEFAULT_TAGSにフォールバックする(ジャンル名
// 自体はそのままgenreに入れるので、マッピングが無くてもチップとしては
// 出せる)。
const GENRE_TAG_MAP: Record<string, string[]> = {
  "Pop": ["楽しい"],
  "Classical": ["美しい", "リラックス"],
  "Rock": ["ドキドキ", "ワクワク"],
  "J-Pop": ["楽しい", "感動"],
  "Anime": ["楽しい", "ワクワク"],
  "R&B/Soul": ["感動"],
  "K-Pop": ["ワクワク", "楽しい"],
  "Jazz": ["リラックス", "美しい"],
  "Soundtrack": ["感動", "美しい"],
  "World": ["美しい"],
  "Alternative": ["考えさせられる"],
  "Christian & Gospel": ["感動"],
  "Hip Hop/Rap": ["ワクワク"],
  "Electronic": ["ワクワク"],
  "New Age": ["リラックス"],
  "Dance": ["ワクワク", "楽しい"],
  "Vocal": ["美しい"],
  "Country": ["感動"],
  "Opera": ["美しい", "感動"],
  "Singer/Songwriter": ["悲しい", "感動"],
  "Heavy Metal": ["ドキドキ"],
  "Pop in Spanish": ["楽しい"],
  "Latin": ["ワクワク", "楽しい"],
  "Arena Rock": ["ワクワク", "ドキドキ"],
  "Classical Crossover": ["美しい"],
  "Hard Rock": ["ドキドキ"],
  "Salsa y Tropical": ["楽しい", "ワクワク"],
  "House": ["ワクワク"],
  "Musicals": ["楽しい", "感動"],
  "Folk": ["リラックス", "考えさせられる"],
  "Alternative & Rock in Spanish": ["考えさせられる"],
  "Cantopop": ["楽しい"],
  "Mandopop": ["楽しい"],
  "French Pop": ["楽しい", "美しい"],
  "Children's Music": ["楽しい"],
  "Blues": ["悲しい", "感動"],
  "Reggae": ["リラックス", "楽しい"],
  "Indie Rock": ["考えさせられる"],
  "Regional Mexicano": ["楽しい"],
  "Ambient": ["リラックス"],
  "Electronica": ["ワクワク"],
  "Funk": ["ワクワク", "楽しい"],
  "Bollywood": ["楽しい", "ワクワク"],
  "Gospel": ["感動"],
  "Spoken Word": ["考えさせられる"],
  "Video Game": ["ワクワク"],
  "Soul": ["感動"],
  // 「怖い」「笑い」は物語が無い音楽には合わせづらいタグだが、実際には
  // 該当するジャンルがある(コメディソング、デスメタル/インダストリアルの
  // 不穏・冷たい質感等)。この2つだけ無理に対応ジャンルが無いと決めつけず、
  // ここに実在する分だけ割り当てる(オーナー指摘)。同じ理由で「悲しい」も
  // 以前はどのジャンルにも割り当てておらず、音楽モードで「悲しい」を選ぶと
  // 必ず0件になっていた(オーナー指摘:「感情検索しても出しにくい」)。
  // Blues・Singer/Songwriterは内容的に素直に当てはまるので割り当てる。
  "Comedy": ["笑い"],
  "Standup Comedy": ["笑い"],
  "Death Metal/Black Metal": ["怖い"],
  "Industrial": ["怖い"],
};
const DEFAULT_TAGS = ["楽しい"];
// countryは元々「どの国のiTunesチャートから取り込んだか」をそのまま使って
// いたが、チャートの中身は輸入ヒット曲だらけ(日本のPopチャートにMichael
// JacksonやSHINee等)なので、実際のアーティストの出身国とは無関係なことが
// 多かった(オーナー指摘:「ポップで日本と打ったら日本以外の作品が出た」)。
// ジャンル名自体がほぼ一国に対応する(K-Pop=韓国等)場合だけ、チャートより
// こちらを信頼して上書きする。genreが「Pop」「Rock」のような汎用語の
// 場合は依然として手がかりが無く、この方式では直せない(アーティスト単位の
// 出身国データが別途必要で、今回の修正範囲外)。
const GENRE_COUNTRY_OVERRIDE: Record<string, string> = {
  "K-Pop": "韓国",
  "J-Pop": "日本",
  "Anime": "日本",
  "Cantopop": "香港",
  "French Pop": "フランス",
  "Bollywood": "インド",
};
// 音楽アルバムは基本的に低刺激。Lookup APIのcollectionExplicitnessが
// "explicit"の時だけ底上げする(fetchExplicitness参照)。
const BASE_TIER = 15;

// 以前はjp/us/gb/kr/fr/deの6ヶ国しかここに無く、他の国を指定して取り込むと
// (例: country="br")日本語化されず生のISOコード("br"等)がcountry列に
// そのまま入ってしまっていた(「詳しく絞り込む」のFILTER_COUNTRIESとも
// 一致せず、絞り込みにも詳細ページの表示にも使えない壊れた値だった)。
// 実際に取り込み済みの国を全てここに追加する。
const COUNTRY_NAME_JA: Record<string, string> = {
  jp: "日本", us: "アメリカ", gb: "イギリス", kr: "韓国", fr: "フランス", de: "ドイツ",
  it: "イタリア", es: "スペイン", ca: "カナダ", mx: "メキシコ", se: "スウェーデン", dk: "デンマーク",
  br: "ブラジル", ru: "ロシア", ie: "アイルランド", nl: "オランダ", pl: "ポーランド", ch: "スイス",
  ar: "アルゼンチン", tr: "トルコ", no: "ノルウェー", fi: "フィンランド", at: "オーストリア",
  lu: "ルクセンブルク", ro: "ルーマニア", tw: "台湾", za: "南アフリカ", nz: "ニュージーランド",
  pt: "ポルトガル", in: "インド", hk: "香港", be: "ベルギー", au: "オーストラリア", cn: "中国",
  th: "タイ", hu: "ハンガリー", cz: "チェコ", cl: "チリ",
  gr: "ギリシャ", vn: "ベトナム", id: "インドネシア", sg: "シンガポール", il: "イスラエル",
  co: "コロンビア", eg: "エジプト", ve: "ベネズエラ", pe: "ペルー", my: "マレーシア",
  ng: "ナイジェリア", ph: "フィリピン", ae: "アラブ首長国連邦", sk: "スロバキア",
  sa: "サウジアラビア", ua: "ウクライナ", bg: "ブルガリア", si: "スロベニア", kz: "カザフスタン",
  lt: "リトアニア", ee: "エストニア", uz: "ウズベキスタン", cr: "コスタリカ", lv: "ラトビア",
  by: "ベラルーシ", am: "アルメニア", gt: "グアテマラ", mt: "マルタ", la: "ラオス",
  cy: "キプロス", bn: "ブルネイ", ke: "ケニア", tt: "トリニダード・トバゴ",
  do: "ドミニカ共和国", lb: "レバノン", hn: "ホンジュラス", jo: "ヨルダン", az: "アゼルバイジャン",
  om: "オマーン", pa: "パナマ", ec: "エクアドル", bh: "バーレーン", py: "パラグアイ",
  qa: "カタール", kh: "カンボジア", bo: "ボリビア", md: "モルドバ", ni: "ニカラグア", sv: "エルサルバドル",
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChart(country: string, limit: number, genreId?: string) {
  const path = genreId
    ? `/${country}/rss/topalbums/limit=${limit}/genre=${genreId}/json`
    : `/${country}/rss/topalbums/limit=${limit}/json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(RSS_BASE + path);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        await sleep(800 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// topalbumsのRSSフィード自体には露骨な表現の有無を示すフィールドが
// そもそも存在しない(確認済み: 実際のレスポンスにrating/explicit系の
// キーが一切無い)。以前の「タイトル文字列に"Explicit"が含まれるか」判定は
// この前提が誤りで、実データ12,000件超のどれにも一度も一致していなかった
// (オーナー指摘: 「音楽の表現度をどう捉えるか」で発覚)。Lookup API
// (/lookup?id=...)はcollectionExplicitness("explicit"/"cleaned"/
// "notExplicit")を返すため、RSSエントリに元々付いているim:id(Apple側の
// アルバムID、既存データとの突き合わせ不要で確実)でまとめて問い合わせる。
async function fetchExplicitness(appleIds: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const CHUNK = 150; // Lookup APIの実用上限に合わせて分割
  for (let i = 0; i < appleIds.length; i += CHUNK) {
    const chunk = appleIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const url = `https://itunes.apple.com/lookup?id=${chunk.join(",")}&entity=album`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          for (const r of data?.results || []) {
            if (r?.collectionId != null) {
              result.set(String(r.collectionId), r.collectionExplicitness === "explicit");
            }
          }
          break;
        }
        if (res.status === 429 || res.status >= 500) { await sleep(800 * (attempt + 1)); continue; }
        break;
      } catch {
        await sleep(500 * (attempt + 1));
      }
    }
    await sleep(200);
  }
  return result;
}

// artworkUrlは末尾が"NNxNNbb.png"の形(例: 170x170bb.png)で、このNNxNNを
// 差し替えるとその解像度の画像がそのまま返ってくる(iTunes側の既知の仕様)。
// RSSは最大でも170x170までしか含まないため、一覧表示に十分な600x600へ
// 差し替えて使う。
function upsizeArtwork(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\d+x\d+bb\.(png|jpg)/, "600x600bb.$1");
}

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

async function selectAllRows(supabase: any, table: string, columns: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

Deno.serve(async (req: Request) => {
  try {
    const {
      country = "jp",
      limit = 100, // このAPIの実質上限は200
      genre_id = null, // 例: J-Pop=27, K-Pop=51, ロック=21, ヒップホップ=18, クラシック=5, アニメ=29
      dry_run = true,
      // 自動の日次取り込み用。1日に入れる件数を抑えたい(「少しずつでいい」との
      // オーナー要望)ため、新規候補が見つかった順に先頭N件だけ挿入したら
      // 残りは見ない。既存の"limit"(チャート取得件数)とは別物なので名前を分ける。
      insert_limit = null,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    const existingTitles = new Set(existingRows.map((r: any) => normalizeTitle(r.title)));

    const data = await fetchChart(country, Math.min(200, Math.max(1, limit)), genre_id || undefined);
    const entries = data?.feed?.entry;
    if (!entries) {
      return new Response(JSON.stringify({ error: "itunes_api_error", body: data }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
    const list = Array.isArray(entries) ? entries : [entries];

    // RSSエントリ自身が持つim:id(Apple側のアルバムID)でLookup APIに
    // まとめて問い合わせ、実際のcollectionExplicitnessを取得する
    // (fetchExplicitness参照。タイトル文字列の"Explicit"判定は実データに
    // 一度も一致しない誤った前提だったため廃止)。
    const appleIds = list.map((e: any) => e?.id?.attributes?.["im:id"]).filter(Boolean);
    const explicitByAppleId = await fetchExplicitness(appleIds);

    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    for (const e of list) {
      if (insert_limit != null && rows.length >= insert_limit) break;
      const title = e?.["im:name"]?.label;
      if (!title) { skipped.push({ reason: "no_title" }); continue; }
      if (existingTitles.has(normalizeTitle(title))) { skipped.push({ title, reason: "duplicate" }); continue; }
      existingTitles.add(normalizeTitle(title)); // 同じチャート内での重複取り込みも防ぐ

      const artist = e?.["im:artist"]?.label || null;
      const genreName = e?.category?.attributes?.term || null;
      const releaseLabel = e?.["im:releaseDate"]?.label; // "2026-09-28T00:00:00-07:00"形式
      const year = releaseLabel ? parseInt(String(releaseLabel).slice(0, 4), 10) : null;
      const images = e?.["im:image"];
      const lastImage = Array.isArray(images) ? images[images.length - 1] : images;
      const artworkUrl = upsizeArtwork(lastImage?.label);
      const trackCount = e?.["im:itemCount"]?.label;

      const appleId = e?.id?.attributes?.["im:id"];
      const tags = (genreName && GENRE_TAG_MAP[genreName]) || DEFAULT_TAGS;
      const isExplicit = appleId ? !!explicitByAppleId.get(appleId) : false;
      const level = isExplicit ? 40 : BASE_TIER;

      rows.push({
        title,
        release_year: year,
        emotion_tags: tags,
        genre: genreName ? [genreName] : null,
        director: artist,
        cast_members: null,
        // 万一この先さらに新しい国コードで取り込む時のための保険。生コードを
        // そのまま入れる(今回の不具合と同じ形)よりは、「海外」とだけ分かる
        // 方がまだ安全(絞り込み・表示どちらでも破綻しない)。
        country: (genreName && GENRE_COUNTRY_OVERRIDE[genreName]) || COUNTRY_NAME_JA[country] || "海外",
        synopsis: trackCount ? `収録曲数: ${trackCount}曲` : null,
        poster_path: artworkUrl,
        japan_release_date: country === "jp" && releaseLabel ? releaseLabel.slice(0, 10) : null,
        japan_release_checked_at: new Date().toISOString(),
        keywords: null,
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "music",
        is_anime: false,
        is_drama: false,
        is_manga: false,
        is_novel: false,
        is_music: true,
        _level: level,
        _explicit: isExplicit,
      });
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ _level, _explicit, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      if (insertedRows?.length) {
        const levelByTitle = new Map(rows.map((r) => [normalizeTitle(r.title), r._level]));
        // 映画等の暴力・性的・恐怖の3カテゴリは音楽には馴染まないため、
        // 音楽だけの理由タグとして"explicit"(露骨な表現)を別途用意する
        // (オーナー指摘: 「音楽の表現度をどう捉えるか、説明書きを変えないと」)。
        const explicitByTitle = new Map(rows.map((r) => [normalizeTitle(r.title), r._explicit]));
        const estimateRows = insertedRows
          .map((r: any) => {
            const level = levelByTitle.get(normalizeTitle(r.title));
            if (level == null) return null;
            const isExplicit = explicitByTitle.get(normalizeTitle(r.title));
            return {
              movie_id: r.id,
              expression_level: level,
              reason_tags: isExplicit ? ["explicit"] : [],
              source: `itunes_music_batch(${new Date().toISOString().slice(0, 10)})`,
              method: "rating_mapping",
            };
          })
          .filter(Boolean);
        if (estimateRows.length) {
          const { error: estErr, count } = await supabase
            .from("movie_expression_estimates")
            .upsert(estimateRows, { onConflict: "movie_id", ignoreDuplicates: true, count: "exact" });
          if (estErr) throw estErr;
          estimatesInserted = count ?? estimateRows.length;
        }
      }
    }

    return new Response(
      JSON.stringify({
        dry_run,
        fetched: list.length,
        duplicates_skipped: skipped.length,
        would_insert: rows.length,
        inserted,
        estimates_inserted: estimatesInserted,
        rows: dry_run ? rows : undefined,
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
// 楽天ウェブサービスは2026年2月の移行でopenapi.rakuten.co.jpドメイン＋
// accessKeyが必須になった。さらにアプリ登録時に設定した「アプリケーションURL」を
// Referer/Originヘッダーとして送らないと弾かれる(REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING)。
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// AniList(海外API)は漫画のあらすじが英語で、無料翻訳APIの1日の上限がすぐ尽きて
// しまう問題があったため、最初から日本語であらすじ・著者・表紙が取れる国内の
// 楽天ブックス書籍検索APIに切り替えた。翻訳が一切不要になる。
// ただし楽天は「巻ごと」の書誌データベースなので、タイトルから推定したシリーズ名で
// グルーピングし、代表の1冊(巻数が一番若いもの)だけをカタログの1作品として扱う。

// 楽天のbooksGenreId(コミック配下)の先頭9桁で大まかな読者層が分かる。
// ジャンルの詳細(アクション/ホラー等)までは取れないため、読者層から
// 大まかな感情タグ・ジャンルに変換する簡易マッピング。
// 実際のジャンルツリー(BooksGenre/Searchで確認済み、2026年時点)は
// 001001001少年/001001002少女/001001003青年/001001004レディース/
// 001001006文庫/001001012その他。以前ここに書いていた「001001005=BL」
// 「001001006=TL」は誤り(001001005は現在存在しない子ジャンルで、
// 001001006は単に文庫版という書籍の版型であり読者層でも内容ジャンルでも
// ない)。この誤りにより、文庫版で売られている全年齢作品(「ジョジョの
// 奇妙な冒険」文庫版セット等)が「恋愛・表現度65・sexual」に誤分類される
// 実害が出たため、文庫版はDEFAULT_GENREへのフォールバックに任せる。
const GENRE_PREFIX_MAP: Record<string, { ja: string | null; tags: string[]; baseTier: number }> = {
  "001001001": { ja: "アクション", tags: ["ワクワク", "ドキドキ"], baseTier: 15 }, // 少年コミック
  "001001002": { ja: "恋愛", tags: ["感動", "美しい"], baseTier: 15 }, // 少女コミック
  "001001003": { ja: "ドラマ", tags: ["考えさせられる", "ドキドキ"], baseTier: 40 }, // 青年コミック
  "001001004": { ja: "恋愛", tags: ["感動", "悲しい"], baseTier: 40 }, // 女性コミック(レディース)
};
const DEFAULT_GENRE = { ja: null, tags: ["楽しい"], baseTier: 15 };

function genreInfoFor(booksGenreId: string | null | undefined) {
  if (!booksGenreId) return DEFAULT_GENRE;
  // 1商品が複数ジャンルIDを持つ場合は"/"区切りで返ってくるため先頭だけ見る。
  const first = booksGenreId.split("/")[0];
  const prefix = first.slice(0, 9);
  return GENRE_PREFIX_MAP[prefix] || DEFAULT_GENRE;
}

// GENRE_PREFIX_MAPは「読者層(少年/少女/青年/女性/BL/TL)」からの大雑把な
// 推定にすぎず、同じ少年コミックでもバトル物・スポーツ物・コメディ等
// 内容は様々なのにどれも「アクション」になってしまう。楽天からは内容
// ジャンルそのものは取れないため、あらすじ(itemCaption)に出てくる
// キーワードで内容を推定し、一致した場合だけ読者層ベースの推定を上書き
// して精度を上げる(一致しない場合は今まで通り読者層ベースのままにする)。
// 上から順に判定し、最初に一致したものを採用する。
const CONTENT_GENRE_KEYWORDS: { pattern: RegExp; ja: string; tags: string[] }[] = [
  { pattern: /(怪異|幽霊|呪い|呪われ|化け物|怨霊|恐怖)/, ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  { pattern: /(謎|事件|推理|探偵|犯人|密室|殺人)/, ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  { pattern: /(異世界|転生|転移|魔王|魔法使い|勇者)/, ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  { pattern: /(宇宙船|宇宙|人工知能|ロボット|近未来|タイムマシン)/, ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  { pattern: /(甲子園|部活|大会優勝|全国大会|チームメイト)/, ja: "アクション", tags: ["ワクワク", "感動"] },
  { pattern: /(ギャグ|爆笑|笑える|コメディ|ドタバタ)/, ja: "コメディ", tags: ["楽しい", "笑い"] },
  { pattern: /(恋|片思い|両想い|告白|付き合(う|い)|ラブストーリー)/, ja: "恋愛", tags: ["感動", "美しい"] },
  { pattern: /(戦争|軍隊|兵士|戦場)/, ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  { pattern: /(バトル|激突|死闘|決戦|強敵|復讐)/, ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
];
function refineGenreWithCaption(baseInfo: { ja: string | null; tags: string[]; baseTier: number }, caption: string) {
  if (!caption) return baseInfo;
  const hit = CONTENT_GENRE_KEYWORDS.find((k) => k.pattern.test(caption));
  if (!hit) return baseInfo;
  return { ja: hit.ja, tags: hit.tags, baseTier: baseInfo.baseTier };
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_WORDS = ["惨殺", "拷問", "陵辱", "強姦", "グロテスク", "残虐", "自殺", "虐待"];
const SEXUAL_WORDS = ["性的", "ヌード", "官能", "濡れ場", "エッチ"];

// コミックカテゴリ配下には、物語作品の漫画本編ではない便乗商品(旅行ガイド・
// シールブック・設定資料集など)が紛れ込むことがあるため、タイトルの
// キーワードで明らかな非漫画商品を取り込み対象から除外する。
const NON_MANGA_TITLE_PATTERNS = [
  "地球の歩き方", "シールブック", "設定資料集", "ぬり絵", "コンプリートガイド", "公式ガイドブック",
];
function isNonMangaTitle(title: string): boolean {
  return NON_MANGA_TITLE_PATTERNS.some((w) => title.includes(w));
}

function estimateExpression(genreId: string | null | undefined, caption: string): { level: number; reasonTags: string[]; basis: string } {
  const info = genreInfoFor(genreId);
  let level = info.baseTier;
  let basis = "genre-demographic";
  const reasons = new Set<string>();

  if (HEAVY_WORDS.some((w) => caption.includes(w))) {
    level = Math.max(level, TIER.INTENSE);
    reasons.add("violence");
    basis = "keyword-heavy";
  } else if (SEXUAL_WORDS.some((w) => caption.includes(w))) {
    level = Math.max(level, TIER.STRONG);
    reasons.add("sexual");
    basis = "keyword-sexual";
  }
  return { level, reasonTags: Array.from(reasons), basis };
}

// タイトルから巻数表記("キングダム 81"や"ONE PIECE(105)"等)以降を切り捨てて
// シリーズ名を推定する。楽天のseriesNameは常に出版レーベル名(「ジャンプ
// コミックス」等)が入っており作品名としては使えない(複数の別作品が同じ
// レーベル名になり、代表作品名まで潰れてしまう)ため、シリーズ名の判定は
// このtitleベースの推定だけに頼る。巻数マーカーの後ろに「特装版」等の
// 副題が続く場合も、マーカーの位置で切ることで同一巻の通常版と特装版を
// 同じシリーズキーにまとめられる。
// 「(グッズ名)付き　(本来のタイトル)」のように、特典名が先頭に付いた形で
// 返ってくる商品があるため、シリーズ名判定の前にこの先頭プレフィックスを取り除く。
function stripBonusPrefix(title: string): string {
  const m = title.match(/^.{1,20}付き[\s　]+(.+)$/u);
  return m ? m[1] : title;
}

// 「【楽天ブックス限定特典】彼方から 小冊子付き愛蔵版 4(ミニ複製原画風
// カード1枚)」のような特典グッズのSKUは、括弧内が特典の説明文になって
// いるため、タグを取り除いた後にその説明もまとめて切り落とす。
function stripRetailTags(title: string): string {
  const m = title.match(/^【(バーゲン本|サイン本|楽天ブックス限定特典|特典)】\s*(.+)$/u);
  if (!m) return title.trim();
  const rest = m[2];
  const parenIdx = rest.search(/[\(（]/u);
  return (parenIdx === -1 ? rest : rest.slice(0, parenIdx)).trim();
}

// ISBN(978/979で始まる13桁)ではなく楽天独自のJANコードが振られている
// 商品は特典グッズのSKUであることが多く、書影の代わりに「特典の内容を
// 説明するテキストカード」画像が入っていることが多い(実際の表紙ではない)。
function isGoodsIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && !/^97[89]/.test(isbn);
}

function stripVolumeSuffix(rawTitle: string): string {
  const title = stripRetailTags(stripBonusPrefix(rawTitle));
  // 「王家の紋章（第54巻）」のような、古い作品の重版・文庫化で使われる
  // 「第N巻」表記。これを見逃すと同じ作品の巻違いがバラバラの別作品として
  // カタログに残ってしまう(実例:「ブッダ（第5巻）」「ブッダ（第6巻）」が
  // 別作品として重複登録されていた)。
  const withKanjiVolume = title.match(/^(.*?)[\s　]*[\(（]?第[0-9０-９]+[巻冊集][\)）]?\s*$/u);
  if (withKanjiVolume) return withKanjiVolume[1].trim();
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  // 「高嶺の花男くん8」のようにスペース無しで巻数が直接くっつく表記は、
  // 「ゴルゴ13」「モブサイコ100」のように数字自体がタイトルの一部の作品も
  // 実在し、区別が付かないため、ここでは切り落とさない(安全側に倒す)。
  return title.trim();
}

// タイトル・シリーズ名から巻数を推定し、シリーズ内で最も若い巻を代表として選ぶための数値。
function extractVolumeNumber(title: string): number {
  const match = title.match(/第([0-9０-９]+)[巻冊集]|[\(（]([0-9]+)[\)）]|[\s　]([0-9]+)\s*$/);
  if (!match) return 0;
  const num = match[1] || match[2] || match[3];
  return num ? parseInt(num, 10) : 0;
}

// 「ブッダ（全12巻セット）」「三国志（全30巻セット）」「STEEL BALL RUN
// 文庫版 コミック 全16巻 完結セット」のようなまとめ買いセットSKUは、単巻の
// 巻1を差し置いてシリーズ代表になってしまうと不自然なため、代表候補として
// 採用しない。以前はstrip-and-compare方式(まとめ買い表記を取り除いた
// 結果が元と違うかどうかで判定)だったが、「全16巻 完結セット」のように
// 巻数と修飾語の間に空白がある表記や、修飾語の後に「（化粧ケース入り）」
// のような注記が続く表記を取りこぼし、実際にセットSKUがそのまま登録されて
// しまう事故があったため、単純に「まとめ買いを示す語がどこかに含まれるか」
// を見る方式に切り替えた(誤判定は「取り込まない」という安全側にしか
// 倒れないため、多少広めに引っかけても実害が無い)。
function isBundleTitle(title: string): boolean {
  return /(全[0-9０-９]+[巻冊集]|[0-9０-９]+[-－][0-9０-９]+[巻冊][\s　]*セット|[0-9０-９]+[巻冊][\s　]*セット|完結セット)/u.test(title);
}

// 楽天のsalesDateは"2027年04月23日頃"のような未発売(予約)の日付や、
// 日付未定の商品には"3099年12月31日"のようなダミーの遠未来日付が入って
// いることがある。他の作品(映画等)と同じく「日本で未発売の新作は発見
// 導線に出さない」方針のため、salesDateが実行時点より未来の商品は
// (巻数が若くても)取り込み対象から除外する。
function parseSalesDate(salesDate: string | null | undefined): Date | null {
  const m = String(salesDate || "").match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
  if (!m) return null;
  const date = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  return isNaN(date.getTime()) ? null : date;
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

async function selectAllRows(supabase: any, table: string, columns: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

const SYNOPSIS_MAX_LEN = 400;

Deno.serve(async (req: Request) => {
  try {
    const {
      pages = [1],
      hits = 30,
      sort = "sales", // standard | sales | -releaseDate | +releaseDate | reviewCount | reviewAverage
      books_genre_id = "001001", // コミック
      dry_run = true,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    // 既存タイトルは、以前このstripVolumeSuffix修正が入る前に「（第9巻）」の
    // ような巻数付きのまま登録された行が混じっているため、素の文字列同士の
    // 比較だけでは「作品名（第9巻）」と後から入ってきた素の「作品名」を
    // 別作品と誤認して両方登録してしまう(実例:「ブッダ（第5巻）」と後発の
    // 「ブッダ」が重複登録された)。既存タイトル側もstripVolumeSuffixで
    // 正規化してから比較することで、この手のクロスバッチ重複を防ぐ。
    const existingTitles = new Set(existingRows.map((r: any) => normalizeTitle(stripVolumeSuffix(r.title))));

    const candidates: any[] = [];
    for (const page of pages) {
      const data = await rakutenFetch({
        booksGenreId: books_genre_id,
        hits: String(hits),
        page: String(page),
        sort,
      });
      if (data?.error) {
        return new Response(JSON.stringify({ error: "rakuten_api_error", status: data.status, body: data.body }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      const items = (data?.Items || []).map((w: any) => w.Item);
      candidates.push(...items);
      await sleep(300);
    }

    // シリーズ単位にグルーピングし、各シリーズの代表(最も若い巻)だけを残す。
    const groups = new Map<string, any[]>();
    for (const c of candidates) {
      const seriesKey = stripVolumeSuffix(c.title) || (c.seriesName && c.seriesName.trim()) || c.title;
      if (!seriesKey) continue;
      const list = groups.get(seriesKey) || [];
      list.push(c);
      groups.set(seriesKey, list);
    }

    const representatives: { key: string; item: any }[] = [];
    for (const [key, list] of groups.entries()) {
      // 特典グッズのSKU(ISBNが978/979で始まらない)は、書影が無い(テキスト
      // カード画像しか無い)ことが多いため、通常の単巻商品より後回しにする。
      // まとめ買いセット(全N巻セット等)も同様に、単巻商品があればそちらを優先する。
      list.sort((a, b) => {
        const bundleDiff = Number(isBundleTitle(a.title)) - Number(isBundleTitle(b.title));
        if (bundleDiff !== 0) return bundleDiff;
        const goodsDiff = Number(isGoodsIsbn(a.isbn)) - Number(isGoodsIsbn(b.isbn));
        if (goodsDiff !== 0) return goodsDiff;
        return extractVolumeNumber(a.title) - extractVolumeNumber(b.title);
      });
      representatives.push({ key, item: list[0] });
    }

    const fresh = representatives.filter((r) => !existingTitles.has(normalizeTitle(r.key)));

    const now = new Date();
    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    for (const { key, item } of fresh) {
      if (isNonMangaTitle(item.title)) {
        skipped.push({ key, reason: "non_manga_title" });
        continue;
      }
      if (isBundleTitle(item.title)) {
        // グループ内に単巻商品が1つも無く、まとめ買いセットしか無かった
        // 場合。不自然な代表タイトルになるくらいなら取り込まない。
        skipped.push({ key, reason: "bundle_set_only" });
        continue;
      }
      const saleDate = parseSalesDate(item.salesDate);
      if (saleDate && saleDate.getTime() > now.getTime()) {
        skipped.push({ key, reason: "unreleased", salesDate: item.salesDate });
        continue;
      }
      const caption = (item.itemCaption || "").trim();
      const genreInfo = refineGenreWithCaption(genreInfoFor(item.booksGenreId), caption);
      const year = saleDate ? saleDate.getUTCFullYear() : null;
      // 表紙画像が無い商品は楽天の「NO IMAGE」プレースホルダーが入るため、
      // そのまま使わずnullにしてサイト側のデフォルト表示に任せる。特典グッズの
      // SKUも書影ではなく「特典内容を説明するテキストカード」画像であることが
      // 多いため、同様に使わない。
      const isNoImage = (url: string | null | undefined) => !url || /noimage/i.test(url);
      const coverUrl = isGoodsIsbn(item.isbn)
        ? null
        : !isNoImage(item.largeImageUrl)
        ? item.largeImageUrl
        : !isNoImage(item.mediumImageUrl)
        ? item.mediumImageUrl
        : null;

      rows.push({
        title: key,
        release_year: year,
        emotion_tags: genreInfo.tags,
        genre: genreInfo.ja ? [genreInfo.ja] : null,
        director: item.author || null,
        cast_members: null,
        country: "日本",
        synopsis: caption ? caption.slice(0, SYNOPSIS_MAX_LEN) : null,
        poster_path: coverUrl,
        japan_release_date: null,
        japan_release_checked_at: null,
        keywords: null,
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "manga",
        is_anime: false,
        is_drama: false,
        is_manga: true,
        _key: key,
      });

      const est = estimateExpression(item.booksGenreId, caption);
      estimates.push({ key, level: est.level, reasonTags: est.reasonTags, basis: est.basis, isbn: item.isbn });
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ _key, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      if (insertedRows?.length) {
        const idByTitle = new Map(insertedRows.map((r: any) => [normalizeTitle(r.title), r.id]));
        const estimateRows = estimates
          .map((e) => {
            const movieId = idByTitle.get(normalizeTitle(e.key));
            if (!movieId) return null;
            return {
              movie_id: movieId,
              expression_level: e.level,
              reason_tags: e.reasonTags,
              source: `rakuten_batch(${new Date().toISOString().slice(0, 10)}):${e.basis};isbn=${e.isbn || ""}`,
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
        candidates_fetched: candidates.length,
        series_grouped: representatives.length,
        duplicates_skipped: representatives.length - fresh.length,
        unreleased_skipped: skipped.length,
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

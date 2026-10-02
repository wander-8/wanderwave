import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// rakuten-discover-mangaと同じ楽天ブックス書籍検索APIを使い、小説を取り込む。
// booksGenreId="001004"(小説・エッセイ)と"001017"(ライトノベル)の2カテゴリを
// 対象にする(呼び出し側でbooks_genre_idを切り替えて2回叩く想定)。
// 1商品が複数のジャンル階層(文庫/絵本/小説等)に同時に属することが多く、
// 物語作品かどうかの判定は先頭のジャンルIDだけでは不十分(例:
// エッセイ集が"001020014/001004003001"のように新書側が先頭に来る)。
// そのため、"/"区切りの全セグメントを見て、ここに列挙した「小説の
// サブジャンル」に1つでも当てはまれば小説候補として扱う(ホワイトリスト方式)。
// 当てはまらない場合はエッセイ・ノンフィクション・実用書等とみなして除外する。
const GENRE_PREFIX_MAP: Record<string, { ja: string[] | null; tags: string[]; baseTier: number }> = {
  "001004001": { ja: ["ミステリー"], tags: ["考えさせられる", "ドキドキ"], baseTier: 40 }, // ミステリー・サスペンス
  "001004002": { ja: ["SF", "ホラー"], tags: ["怖い", "考えさせられる"], baseTier: 40 }, // SF・ホラー
  "001004008": { ja: ["ドラマ"], tags: ["感動", "考えさせられる"], baseTier: 15 }, // 日本の小説
  "001004009": { ja: ["ドラマ"], tags: ["感動", "考えさせられる"], baseTier: 15 }, // 外国の小説
  "001004016": { ja: ["恋愛"], tags: ["感動", "美しい"], baseTier: 15 }, // ロマンス
  "001017005": { ja: ["アクション", "ファンタジー"], tags: ["ワクワク", "ドキドキ"], baseTier: 15 }, // ライトノベル(少年)
  "001017006": { ja: ["恋愛", "ファンタジー"], tags: ["ドキドキ", "感動"], baseTier: 15 }, // ライトノベル(少女)
};
// 「その他」の小説カテゴリ。小説候補と認めるが、具体的なジャンル名は付けない。
const FICTION_CATCHALL_PREFIXES = new Set(["001004015", "001017004"]);
const FICTION_PREFIXES = new Set([...Object.keys(GENRE_PREFIX_MAP), ...FICTION_CATCHALL_PREFIXES]);
const DEFAULT_GENRE = { ja: null, tags: ["楽しい"], baseTier: 15 };

// 小説以外の「本」サブカテゴリ(絵本・新書・図鑑)。物語作品かどうかを判定する
// isFictionCandidate()は小説専用のロジックなので、この3カテゴリを対象に
// 呼び出す時は使わず、該当ジャンルの商品をすべてそのまま候補として扱う
// (呼び出し側でbooks_genre_idにこのマップのキーを渡した時だけ有効になる)。
const DIRECT_BOOK_TYPE_MAP: Record<string, { ja: string; tags: string[]; baseTier: number }> = {
  "001003003": { ja: "絵本", tags: ["楽しい", "美しい"], baseTier: 15 },
  "001003006": { ja: "図鑑", tags: ["考えさせられる", "美しい"], baseTier: 15 },
  "001020": { ja: "新書", tags: ["考えさせられる"], baseTier: 15 },
};

// 「その他」は物語作品以外(占い本・絵本・実用書等)も同居しており、それらは
// 別の上位ジャンルにも重複登録されていることが多い。そこで、この上位
// ジャンル(6桁)が1つでも付いている商品は、小説の他ジャンルと重複していても
// 除外する(実例: 占い本が"001004015/001010007007"のように「小説その他」+
// 「美容・暮らし・健康」の両方を持っていた)。
const EXCLUDED_TOP_PREFIXES = new Set([
  "001002", // 語学・学習参考書
  "001003", // 絵本・児童書・図鑑
  "001005", // パソコン・システム開発
  "001006", // ビジネス・経済・就職
  "001007", // 旅行・留学・アウトドア
  "001008", // 人文・思想・社会
  "001009", // ホビー・スポーツ・美術
  "001010", // 美容・暮らし・健康・料理
  "001012", // 科学・技術
  "001013", // 写真集・タレント
  "001016", // 資格・検定
  "001018", // 楽譜
  "001026", // カレンダー・手帳・家計簿
  "001027", // 文具・雑貨
  "001028", // 医学・薬学・看護学・歯科学
]);

function genreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").map((s) => s.slice(0, 9)).filter(Boolean);
}
function genreInfoFor(booksGenreId: string | null | undefined) {
  for (const seg of genreSegments(booksGenreId)) {
    if (GENRE_PREFIX_MAP[seg]) return GENRE_PREFIX_MAP[seg];
  }
  return DEFAULT_GENRE;
}
// 竹取物語のような古典作品は、学参・人文系の副ジャンル(001002/001008等)と
// 重複して付いていても、具体的な小説ジャンル(001004008=日本の小説等)が
// 明示的に付いていればそれを信頼して残す。「その他」catch-allしか無い場合
// (占い本・絵本が該当)だけ、非物語系ジャンルとの重複を理由に除外する。
function isFictionCandidate(booksGenreId: string | null | undefined): boolean {
  const segs = genreSegments(booksGenreId);
  if (segs.some((seg) => GENRE_PREFIX_MAP[seg])) return true;
  if (!segs.some((seg) => FICTION_CATCHALL_PREFIXES.has(seg))) return false;
  return !segs.some((seg) => EXCLUDED_TOP_PREFIXES.has(seg.slice(0, 6)));
}

// 1商品が複数のジャンルパスを同時に持つことを利用し、他のジャンル(ミステリー・
// SF等)と並行して"001004009"(外国の小説)が付いているかどうかで、翻訳された
// 海外小説かを判定する(実例: 「緋文字(完訳)」は"001019001/001004009")。
const FOREIGN_NOVEL_GENRE = "001004009";
function isForeignNovel(booksGenreId: string | null | undefined): boolean {
  return genreSegments(booksGenreId).includes(FOREIGN_NOVEL_GENRE);
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_WORDS = ["惨殺", "拷問", "陵辱", "強姦", "グロテスク", "残虐", "自殺", "虐待"];
const SEXUAL_WORDS = ["性的", "ヌード", "官能", "濡れ場", "エッチ"];

// コミックと違い、小説カテゴリには目録・読者アンケート等の便乗商品は
// あまり無いが、念のため明らかな非小説商品だけ弾いておく。
const NON_NOVEL_TITLE_PATTERNS = ["地球の歩き方", "設定資料集", "公式ガイドブック", "コンプリートガイド"];
function isNonNovelTitle(title: string): boolean {
  return NON_NOVEL_TITLE_PATTERNS.some((w) => title.includes(w));
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

// 「(グッズ名)付き　(本来のタイトル)」のように、特典名が先頭に付いた形で
// 返ってくる商品があるため、シリーズ名判定の前にこの先頭プレフィックスを取り除く。
function stripBonusPrefix(title: string): string {
  const m = title.match(/^.{1,20}付き[\s　]+(.+)$/u);
  return m ? m[1] : title;
}

// 「【バーゲン本】」「【サイン本】」のような小売り上の状態タグは作品名の
// 一部ではないため、表示用タイトルから取り除く。
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
// 商品は、しおり・ステッカー・複製原画カードのような特典グッズのSKUで
// あることが多く、書影の代わりに「特典の内容を説明するテキストカード」
// 画像が入っていることが多い(実際の表紙ではない)。そのため表紙画像には
// 使わない。
function isGoodsIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && !/^97[89]/.test(isbn);
}

// 「全12巻セット」「（3冊）」のような、まとめ買い用の巻数セット表記を
// 持つ商品はまとめ買いSKUであり、通常の単巻とは別にシリーズ代表として
// 選ばれると「作品名（3冊）」のような不自然な表示になってしまうため、
// 代表候補として採用しない。以前はstrip-and-compare方式だったが、
// 巻数と修飾語の間に空白がある表記(「全16巻 完結セット」等)や修飾語の
// 後に注記が続く表記を取りこぼしていたため、まとめ買いを示す語が
// どこかに含まれるかを見る方式に切り替えた。
function isBundleTitle(title: string): boolean {
  return /(全[0-9０-９]+[巻冊集]|[0-9０-９]+[-－][0-9０-９]+[巻冊][\s　]*セット|[0-9０-９]+[巻冊][\s　]*セット|完結セット)/u.test(title);
}

// タイトルから巻数表記("本好きの下剋上 8"等)以降を切り捨ててシリーズ名を推定する。
// 楽天のseriesNameは(漫画と同じく)出版レーベル名が入っていることが多く
// 作品名として使えないため、シリーズ名の判定はtitleベースの推定だけに頼る。
function stripVolumeSuffix(rawTitle: string): string {
  const title = stripRetailTags(stripBonusPrefix(rawTitle));
  // 「新・人間革命（第21巻）」のような「第N巻」表記(古い作品の重版・文庫化で
  // よく使われる)。これを見逃すと同じ作品の巻違いが別作品として重複登録される。
  const withKanjiVolume = title.match(/^(.*?)[\s　]*[\(（]?第[0-9０-９]+[巻冊集][\)）]?\s*$/u);
  if (withKanjiVolume) return withKanjiVolume[1].trim();
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  // スペース無しで巻数が直接くっつく表記は、数字自体がタイトルの一部の
  // 作品(「ゴルゴ13」「モブサイコ100」等)と区別が付かないため切り落とさない。
  return title.trim();
}

function extractVolumeNumber(title: string): number {
  const match = title.match(/第([0-9０-９]+)[巻冊集]|[\(（]([0-9]+)[\)）]|[\s　]([0-9]+)\s*$/);
  if (!match) return 0;
  const num = match[1] || match[2] || match[3];
  return num ? parseInt(num, 10) : 0;
}

// 楽天のsalesDateは未発売(予約)の日付や、日付未定の商品にはダミーの遠未来
// 日付が入っていることがある。日本で未発売の新作は発見導線に出さない方針
// のため、salesDateが実行時点より未来の商品は取り込み対象から除外する。
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
      books_genre_id = "001004", // 小説・エッセイ("001017"を渡せばライトノベル)
      dry_run = true,
    } = await req.json().catch(() => ({}));

    // DIRECT_BOOK_TYPE_MAPのキー(絵本=001003003・図鑑=001003006・新書=001020)が
    // 渡された時は、小説かどうかの判定(isFictionCandidate)を通さず、
    // そのジャンルの商品をそのまま候補として扱う。genreにも「絵本」等を
    // そのまま入れて、フロント側でジャンルチップとして選べるようにする
    // (is_novelは変えないので、小説と同じ「小説」モード内に混在する)。
    const directBookType = DIRECT_BOOK_TYPE_MAP[books_genre_id];

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    // 既存タイトルは、以前このstripVolumeSuffix修正が入る前に「（第21巻）」の
    // ような巻数付きのまま登録された行が混じっているため、既存タイトル側も
    // stripVolumeSuffixで正規化してから比較し、クロスバッチ重複を防ぐ。
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
    let nonFictionSkipped = 0;
    const groups = new Map<string, any[]>();
    for (const c of candidates) {
      if (!directBookType && !isFictionCandidate(c.booksGenreId)) { nonFictionSkipped++; continue; }
      const seriesKey = stripVolumeSuffix(c.title) || (c.seriesName && c.seriesName.trim()) || c.title;
      if (!seriesKey) continue;
      const list = groups.get(seriesKey) || [];
      list.push(c);
      groups.set(seriesKey, list);
    }

    const representatives: { key: string; item: any }[] = [];
    for (const [key, list] of groups.entries()) {
      // まとめ買いセット(全N冊セット等)や特典グッズのSKU(ISBNが978/979で
      // 始まらない)は、通常の単巻商品より後回しにする(特典グッズは表紙が
      // テキストカード画像なだけでなく、そもそも「作品」ではなく販促グッズ
      // 付きの一SKUに過ぎないため)。
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
      // 非小説タイトルのブラックリスト(地球の歩き方等)は小説パイプライン用
      // なので、絵本・新書・図鑑では適用しない。
      if (!directBookType && isNonNovelTitle(item.title)) {
        skipped.push({ key, reason: "non_novel_title" });
        continue;
      }
      if (isBundleTitle(item.title)) {
        // グループ内に単巻商品が1つも無く、まとめ買いセットしか無かった場合。
        skipped.push({ key, reason: "bundle_set_only" });
        continue;
      }
      const saleDate = parseSalesDate(item.salesDate);
      if (saleDate && saleDate.getTime() > now.getTime()) {
        skipped.push({ key, reason: "unreleased", salesDate: item.salesDate });
        continue;
      }
      const caption = (item.itemCaption || "").trim();
      const genreInfo = directBookType
        ? { ja: [directBookType.ja], tags: directBookType.tags, baseTier: directBookType.baseTier }
        : genreInfoFor(item.booksGenreId);
      const year = saleDate ? saleDate.getUTCFullYear() : null;
      // 表紙画像が無い商品には楽天の「NO IMAGE」プレースホルダー画像が
      // 入っているため、そのまま表示すると全作品同じ灰色画像が並んでしまう。
      // ファイル名にnoimageが含まれる場合はposter_pathをnullにして、
      // サイト側のデフォルト表示(色付きの仮ポスター)に任せる。
      // 特典グッズのSKU(ISBNが978/979で始まらない)は、書影ではなく
      // 「特典内容を説明するテキストカード」画像が入っていることが多いため、
      // 表紙として使わない。
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
        genre: genreInfo.ja,
        director: item.author || null,
        cast_members: null,
        // 以前は全件一律で"日本"にしていたため、翻訳された海外小説
        // (例:「緋文字（完訳）」booksGenreId="001019001/001004009"のように
        // 他のジャンルパスと同時に"001004009"(外国の小説)も持つ)まで
        // 日本作品として記録されてしまい、国で絞り込むと海外小説が
        // 一切出てこなかった。genreSegmentsは既に"/"区切りの全パスを
        // 見ているので、この中に外国の小説ジャンルが含まれるかどうかで
        // 判定する。
        country: isForeignNovel(item.booksGenreId) ? "海外" : "日本",
        synopsis: caption ? caption.slice(0, SYNOPSIS_MAX_LEN) : null,
        poster_path: coverUrl,
        japan_release_date: null,
        japan_release_checked_at: null,
        keywords: null,
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "novel",
        is_anime: false,
        is_drama: false,
        is_manga: false,
        is_novel: true,
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
              source: `rakuten_novel_batch(${new Date().toISOString().slice(0, 10)}):${e.basis};isbn=${e.isbn || ""}`,
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
        non_fiction_skipped: nonFictionSkipped,
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 漫画はTMDbに存在しないため、AniList(https://anilist.co)のGraphQL APIを
// データソースにする。認証キー不要・無料・レート制限も緩く(90req/min)、
// ジャンル・タグ(内容の傾向)・国・表紙画像・作者情報までまとめて1回の
// クエリで取れるため、映画/アニメ/ドラマのように詳細取得を複数回に分ける
// 必要がなく、取り込み時にその場で表現度の推定値まで一緒に計算できる。
const ANILIST_ENDPOINT = "https://graphql.anilist.co";

const GENRE_MAP: Record<string, { ja: string; tags: string[] }> = {
  Action: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
  Adventure: { ja: "アドベンチャー", tags: ["ワクワク", "美しい"] },
  Comedy: { ja: "コメディ", tags: ["楽しい", "笑い"] },
  Drama: { ja: "ドラマ", tags: ["感動", "悲しい", "考えさせられる"] },
  Ecchi: { ja: "恋愛", tags: ["ドキドキ"] },
  Fantasy: { ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  Horror: { ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  "Mahou Shoujo": { ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  Mecha: { ja: "SF", tags: ["ワクワク", "考えさせられる"] },
  Music: { ja: "音楽", tags: ["感動", "楽しい"] },
  Mystery: { ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  Psychological: { ja: "ミステリー", tags: ["考えさせられる", "怖い"] },
  Romance: { ja: "恋愛", tags: ["感動", "悲しい", "美しい"] },
  "Sci-Fi": { ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  "Slice of Life": { ja: "ファミリー", tags: ["楽しい", "感動"] },
  Sports: { ja: "アクション", tags: ["ワクワク", "感動"] },
  Supernatural: { ja: "ファンタジー", tags: ["怖い", "ワクワク"] },
  Thriller: { ja: "スリラー", tags: ["ドキドキ", "怖い"] },
};

const COUNTRY_NAME_JA: Record<string, string> = {
  JP: "日本", KR: "韓国", CN: "中国", TW: "台湾", US: "アメリカ", FR: "フランス", GB: "イギリス",
};
function countryNameJa(code: string | null): string | null {
  if (!code) return null;
  return COUNTRY_NAME_JA[code] || code;
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_TAGS = [
  "gore", "body horror", "torture", "suicide", "self harm", "graphic violence",
  "violence", "death", "murder", "rape", "sexual abuse",
];
const SEXUAL_TAGS = ["ecchi", "fanservice", "nudity", "sexual content"];
const HEAVY_GENRES = new Set(["Horror", "Thriller", "Psychological"]);

// 表現度の推定は、映画/TVと同じくTMDbの年齢区分に相当するものがAniListには
// 無いため、ジャンル・タグ(内容の傾向を表す語)から見積もる。isAdult=trueの
// 作品はそもそも取り込み対象から除外している(18禁を表に出さない方針)ため、
// ここでのINTENSE判定は「表には出すが刺激が強い」層の切り分けに使う。
function estimateExpression(genres: string[], tags: string[]): { level: number; reasonTags: string[]; basis: string } {
  const lowerTags = tags.map((t) => t.toLowerCase());
  const reasons = new Set<string>();
  let level = TIER.LOW;
  let basis = "genre-light";

  if (lowerTags.some((t) => HEAVY_TAGS.some((h) => t.includes(h)))) {
    level = TIER.INTENSE;
    reasons.add("violence");
    basis = "tag-heavy";
  } else if (lowerTags.some((t) => SEXUAL_TAGS.some((s) => t.includes(s))) || genres.includes("Ecchi")) {
    level = TIER.STRONG;
    reasons.add("sexual");
    basis = "tag-sexual";
  } else if (genres.some((g) => HEAVY_GENRES.has(g))) {
    level = TIER.MILD;
    basis = "genre-heavy";
  }

  if (level > TIER.LOW) {
    if (genres.includes("Horror")) reasons.add("fear");
    if (genres.includes("Action") || genres.includes("Thriller")) reasons.add("violence");
  }

  return { level, reasonTags: Array.from(reasons), basis };
}

function pickEmotionTags(genres: string[]): string[] {
  const freq: Record<string, number> = {};
  const order: string[] = [];
  genres.forEach((g) => {
    const mapped = GENRE_MAP[g];
    if (!mapped) return;
    mapped.tags.forEach((t) => {
      if (!(t in freq)) order.push(t);
      freq[t] = (freq[t] || 0) + 1;
    });
  });
  return order.sort((a, b) => freq[b] - freq[a]).slice(0, 3);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// 480文字で単純に切り詰めると文の途中(単語の途中)で切れ、その壊れた
// 英文を翻訳した結果も途中で切れた日本語になってしまう(実例:「Perfect
// Girlfriend Online」のあらすじが「小説「ラブパッチf」で終わっていた。
// オーナー指摘)。tmdb-movie-reviewsと同じく、文の区切り(. ! ?)が
// 見つかればそこで切る。
function trimToSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}

// 翻訳後の日本語あらすじをSYNOPSIS_MAX_LENで切る時も、単純なsliceだと
// 文の途中で切れる。日本語の句点(。！？)で同様に区切る。
function trimToSentenceBoundaryJa(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}

// AniListのdescriptionは英語であることが多く、他の取り込み(映画/アニメ/ドラマ)と
// 同じくMyMemory APIで日本語化する(サイト内の表記を日本語に揃えるため)。
async function translateToJa(text: string): Promise<string> {
  const trimmed = trimToSentenceBoundary(text, 480);
  try {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", trimmed);
    url.searchParams.set("langpair", "en|ja");
    const res = await fetch(url.toString());
    if (!res.ok) return trimmed;
    const data = await res.json();
    const translated = String(data?.responseData?.translatedText || "").trim();
    return translated || trimmed;
  } catch {
    return trimmed;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const QUERY = `
query ($page: Int, $perPage: Int, $sort: [MediaSort], $format: MediaFormat, $countryOfOrigin: CountryCode) {
  Page(page: $page, perPage: $perPage) {
    media(type: MANGA, format: $format, sort: $sort, isAdult: false, countryOfOrigin: $countryOfOrigin) {
      id
      title { romaji english native }
      description(asHtml: false)
      genres
      tags { name isMediaSpoiler rank }
      averageScore
      popularity
      startDate { year }
      countryOfOrigin
      coverImage { extraLarge large }
      staff(perPage: 3) { edges { role node { name { full } } } }
      chapters
      volumes
      status
      isAdult
    }
  }
}`;

async function anilistFetch(variables: Record<string, unknown>) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ANILIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query: QUERY, variables }),
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return null;
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
    const { data, error } = await supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
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
      per_page = 20,
      sort = ["POPULARITY_DESC"],
      format = "MANGA", // MANGA | NOVEL | ONE_SHOT
      country_of_origin = null, // JP | KR | CN など。nullなら全世界
      dry_run = true,
      min_popularity = 100,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    const existingKeys = new Set(
      existingRows.map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}`),
    );

    const candidates: any[] = [];
    for (const page of pages) {
      // AniListは「変数を渡さない」と「nullを渡す」を区別する。countryOfOrigin:null
      // を明示的に送るとcountryOfOriginがnullの作品だけに絞られてしまい(=0件になる)、
      // 「国を問わない」場合はキー自体を省く必要がある。
      const variables: Record<string, unknown> = { page, perPage: per_page, sort, format };
      if (country_of_origin) variables.countryOfOrigin = country_of_origin;
      const data = await anilistFetch(variables);
      const media = data?.data?.Page?.media || [];
      candidates.push(...media);
      await sleep(700); // AniListのレート制限(90req/min)に余裕を持たせる
    }

    // このサイトは日本語話者向けなので、日本産の作品は英語タイトルではなく
// 日本語のネイティブタイトル(例:「進撃の巨人」)を優先する。以前はenglish
// を最優先にしていたため、日本産の漫画の大半が英題("Attack on Titan"等)
// で登録されてしまい、日本語で検索しても一切ヒットしない状態になっていた。
// ただし「ONE PIECE」のように公式表記自体がローマ字のケースもあるため、
// nativeに日本語の文字(かな/漢字)が含まれる場合だけ優先し、それ以外は
// 従来通りenglish→romaji→nativeの順にフォールバックする。
function looksJapaneseText(s: string): boolean {
  return /[぀-ヿ一-鿿]/.test(s);
}
function pickDisplayTitle(c: any): string | null {
  const native = c.title?.native;
  if (c.countryOfOrigin === "JP" && native && looksJapaneseText(native)) return native;
  return c.title?.english || c.title?.romaji || c.title?.native;
}

const fresh = candidates.filter((c: any) => {
      if ((c.popularity || 0) < min_popularity) return false;
      const title = pickDisplayTitle(c);
      if (!title) return false;
      const year = c.startDate?.year || null;
      const key = `${normalizeTitle(title)}|${year}`;
      return !existingKeys.has(key);
    });

    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    const seenInBatch = new Set<string>();
    for (const c of fresh) {
      const title = pickDisplayTitle(c);
      const year = c.startDate?.year || null;
      const key = `${normalizeTitle(title)}|${year}`;
      if (seenInBatch.has(key)) {
        skipped.push({ id: c.id, title, reason: "duplicate_in_batch" });
        continue;
      }
      seenInBatch.add(key);

      const genres: string[] = c.genres || [];
      const tags: string[] = (c.tags || []).filter((t: any) => !t.isMediaSpoiler).map((t: any) => t.name);
      const emotionTags = pickEmotionTags(genres);
      if (emotionTags.length === 0) {
        skipped.push({ id: c.id, title, reason: "no_genre_mapping" });
        continue;
      }
      const genreNames = genres.map((g) => GENRE_MAP[g]?.ja).filter(Boolean);

      const authors = (c.staff?.edges || [])
        .filter((e: any) => /story|art|creator|mangaka/i.test(e.role || ""))
        .map((e: any) => e.node?.name?.full)
        .filter(Boolean);
      const authorList = authors.length ? authors : (c.staff?.edges || []).map((e: any) => e.node?.name?.full).filter(Boolean);

      let synopsis: string | null = null;
      if (c.description) {
        const plain = stripHtml(c.description);
        // 既に日本語(ひらがな/カタカナ/漢字)を含む場合は翻訳せずそのまま使う。
        const looksJapanese = /[぀-ヿ一-鿿]/.test(plain);
        const translated = looksJapanese ? plain : await translateToJa(plain);
        synopsis = trimToSentenceBoundaryJa(translated, SYNOPSIS_MAX_LEN);
      }
      const country = countryNameJa(c.countryOfOrigin);
      const coverUrl = c.coverImage?.extraLarge || c.coverImage?.large || null;

      rows.push({
        title,
        release_year: year,
        emotion_tags: emotionTags,
        genre: genreNames.length ? genreNames : null,
        director: authorList.slice(0, 3).join("、") || null,
        cast_members: null,
        country,
        synopsis,
        poster_path: coverUrl, // フルURL。TMDB_IMAGE_BASEを前置きしないURLとしてクライアント側で判定する。
        japan_release_date: null,
        japan_release_checked_at: null,
        keywords: tags.slice(0, 15),
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "manga",
        is_anime: false,
        is_drama: false,
        is_manga: true,
        anilist_id: c.id,
        anilist_popularity: c.popularity,
        anilist_score: c.averageScore,
      });

      const est = estimateExpression(genres, tags);
      estimates.push({
        anilist_id: c.id,
        title,
        expression_level: est.level,
        reason_tags: est.reasonTags,
        source: `anilist_batch(${new Date().toISOString().slice(0, 10)}):${est.basis};anilist_id=${c.id}`,
      });
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ anilist_id, anilist_popularity, anilist_score, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title, release_year");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      // 挿入されたmovies.idとタイトル+年で突き合わせ、表現度の推定値も
      // 同じバッチでまとめて書き込む(別関数での穴埋めパスを省略できる)。
      if (insertedRows?.length) {
        const idByKey = new Map(insertedRows.map((r: any) => [`${normalizeTitle(r.title)}|${r.release_year}`, r.id]));
        const estimateRows = estimates
          .map((e) => {
            const row = rows.find((r) => r.anilist_id === e.anilist_id);
            if (!row) return null;
            const movieId = idByKey.get(`${normalizeTitle(row.title)}|${row.release_year}`);
            if (!movieId) return null;
            return {
              movie_id: movieId,
              expression_level: e.expression_level,
              reason_tags: e.reason_tags,
              source: e.source,
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
        duplicates_skipped: candidates.length - fresh.length,
        no_genre_mapping_skipped: skipped.length,
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

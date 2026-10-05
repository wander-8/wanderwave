import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-discover-animeと同じ枠組みで、「ドラマ」(実写のTVシリーズ全般)を
// 専用に取り込む。アニメと違って劇場公開は無く、常にmedia_type='tv'。
// アニメ(genre 16)と、ドキュメンタリー・子供番組・ニュース・情報/トーク・
// リアリティ番組は対象外にし(without_genres)、それ以外のジャンルの
// 実写TVシリーズを幅広く対象にする。国は問わず(日本のドラマだけでなく、
// 韓国ドラマ・欧米のTVシリーズなども同じ「ドラマ」枠として扱う方針)。
const GENRE_MAP: Record<number, { ja: string; tags: string[] }> = {
  28: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
  12: { ja: "アドベンチャー", tags: ["ワクワク", "美しい"] },
  35: { ja: "コメディ", tags: ["楽しい", "笑い"] },
  80: { ja: "クライム", tags: ["ドキドキ", "考えさせられる"] },
  18: { ja: "ドラマ", tags: ["感動", "悲しい", "考えさせられる"] },
  10751: { ja: "ファミリー", tags: ["楽しい", "ワクワク"] },
  14: { ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  36: { ja: "歴史", tags: ["考えさせられる", "感動"] },
  27: { ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  10402: { ja: "音楽", tags: ["感動", "楽しい"] },
  9648: { ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  10749: { ja: "恋愛", tags: ["感動", "悲しい", "美しい"] },
  878: { ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  53: { ja: "スリラー", tags: ["ドキドキ", "怖い"] },
  10752: { ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  37: { ja: "西部劇", tags: ["ワクワク", "ドキドキ"] },
  // TV専用ジャンルID
  10759: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] }, // Action & Adventure
  10765: { ja: "SF", tags: ["考えさせられる", "ワクワク"] }, // Sci-Fi & Fantasy
  10768: { ja: "戦争", tags: ["悲しい", "考えさせられる"] }, // War & Politics
  10766: { ja: "ドラマ", tags: ["感動", "悲しい", "考えさせられる"] }, // Soap
};

// アニメ(16)・ドキュメンタリー(99)・子供向け(10762)・ニュース(10763)・
// リアリティ(10764)・トーク(10767)は「ドラマ」の対象外として除外する。
const EXCLUDED_TV_GENRES = "16,99,10762,10763,10764,10767";

const COUNTRY_NAME_JA: Record<string, string> = {
  JP: "日本", CN: "中国", KR: "韓国", US: "アメリカ", FR: "フランス",
  GB: "イギリス", TW: "台湾", HK: "香港", CA: "カナダ", DE: "ドイツ",
  IT: "イタリア", ES: "スペイン", IN: "インド", AU: "オーストラリア",
  MX: "メキシコ", BR: "ブラジル", TH: "タイ", HU: "ハンガリー",
  IE: "アイルランド", AT: "オーストリア", PL: "ポーランド", CZ: "チェコ",
  CH: "スイス", BE: "ベルギー", NL: "オランダ", SE: "スウェーデン",
  DK: "デンマーク", NO: "ノルウェー", FI: "フィンランド", RU: "ロシア",
  NZ: "ニュージーランド", AR: "アルゼンチン", TR: "トルコ",
};
function countryNameJa(iso: string, fallback: string): string {
  return COUNTRY_NAME_JA[iso] || fallback;
}

const SYNOPSIS_MAX_LEN = 400;

// TMDbはソフトコア作品にadult:trueを付けないことが多く、adultフラグだけでは
// 実際のポルノ作品を防げない。2026-09-27に「レイプゾンビ LUST OF THE DEAD」
// シリーズ等、この基準でmoviesテーブルから約500件削除した実例に合わせ、
// 同じキーワード集合で取り込み時にも除外する。
const ADULT_CONTENT_KEYWORDS = new Set([
  "softcore", "hentai", "pink film", "ecchi", "adult animation",
  "animated porn", "roman porno", "unsimulated sex", "erotica",
]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbFetch(path: string, params: Record<string, string>) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
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

function pickEmotionTags(genreIds: number[]): string[] {
  const freq: Record<string, number> = {};
  const order: string[] = [];
  genreIds.forEach((id) => {
    const g = GENRE_MAP[id];
    if (!g) return;
    g.tags.forEach((t) => {
      if (!(t in freq)) order.push(t);
      freq[t] = (freq[t] || 0) + 1;
    });
  });
  return order.sort((a, b) => freq[b] - freq[a]).slice(0, 3);
}

async function translateToJa(text: string): Promise<string> {
  const trimmed = text.slice(0, 480);
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

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

// .order()無しのrange()ページングは行の並び順が安定しないことがあり、
// 既存行の取りこぼしによる重複登録の原因になるため、idで明示的にソートする
// (tmdb-discover-animeで「千と千尋の神隠し」が重複登録された実例を受けた修正)。
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
      pages = [1],
      min_vote_count = 50,
      min_vote_average = 5.0,
      dry_run = true,
      sort_by = "popularity.desc",
      first_air_date_gte = null,
      first_air_date_lte = null,
      with_origin_country = null,
      // 朝ドラ(あまちゃん、ちむどんどん等)のような、国内では有名でも
      // TMDbの投票数が少なく通常のdiscover(人気順/評価順)では出てこない
      // 作品向けに、名指しでタイトル検索して取り込めるようにする
      // (オーナー指摘: 「朝ドラも入れたい」)。指定時はdiscoverの代わりに
      // タイトルごとの/search/tvを使うため、min_vote_count等は適用されない。
      titles = null,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year, tmdb_id");
    const existingKeys = new Set(
      existingRows.map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}`),
    );
    const existingTmdbIds = new Set(existingRows.map((r: any) => r.tmdb_id).filter((v: any) => v != null));

    const candidates: any[] = [];
    if (Array.isArray(titles) && titles.length) {
      // 名指し取り込みモード: タイトルごとに/search/tvを叩き、最有力候補
      // (先頭の1件)だけを採用する。
      for (const title of titles) {
        const data = await tmdbFetch("/search/tv", { query: String(title), language: "ja-JP" });
        if (data?.results?.length) candidates.push(data.results[0]);
        await sleep(150);
      }
    } else {
      // 1) TMDbのdiscover/tvでドラマ候補一覧を取得。
      for (const page of pages) {
        const params: Record<string, string> = {
          language: "ja-JP",
          sort_by,
          without_genres: EXCLUDED_TV_GENRES,
          "vote_count.gte": String(min_vote_count),
          "vote_average.gte": String(min_vote_average),
          page: String(page),
        };
        if (with_origin_country) params["with_origin_country"] = with_origin_country;
        if (first_air_date_gte) params["first_air_date.gte"] = first_air_date_gte;
        if (first_air_date_lte) params["first_air_date.lte"] = first_air_date_lte;
        const data = await tmdbFetch("/discover/tv", params);
        if (data?.results?.length) candidates.push(...data.results);
        await sleep(150);
      }
    }

    // 2) 既存作品との重複を除外(タイトル+公開年で判定)
    const fresh = candidates.filter((c: any) => {
      const year = c.first_air_date ? parseInt(String(c.first_air_date).slice(0, 4), 10) : null;
      const key = `${normalizeTitle(c.name)}|${year}`;
      return !existingKeys.has(key) && !existingTmdbIds.has(c.id);
    });

    // 3) 詳細情報を取得し、挿入用の行を組み立てる
    const rows: any[] = [];
    const skipped: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < fresh.length; i += CONCURRENCY) {
      const chunk = fresh.slice(i, i + CONCURRENCY);
      const chunkRows = await Promise.all(
        chunk.map(async (c: any) => {
          const [details, credits, keywordsRes] = await Promise.all([
            tmdbFetch(`/tv/${c.id}`, { language: "ja-JP" }),
            tmdbFetch(`/tv/${c.id}/credits`, { language: "ja-JP" }),
            tmdbFetch(`/tv/${c.id}/keywords`, {}),
          ]);
          if (!details) return null;

          // 18禁(TMDb側のadultフラグ)は保険として明示的に除外する
          // (include_adult:falseは/discover/tvには効かないため)。
          if (details.adult === true) {
            skipped.push({ tmdb_id: c.id, title: c.name, reason: "adult_flagged" });
            return null;
          }

          const genreIds: number[] = (details.genres || []).map((g: any) => g.id);
          const keywordNames: string[] = (keywordsRes?.results || []).map((k: any) => String(k.name || "").toLowerCase());
          if (keywordNames.some((k) => ADULT_CONTENT_KEYWORDS.has(k))) {
            skipped.push({ tmdb_id: c.id, title: c.name, reason: "adult_content_keyword" });
            return null;
          }
          // アニメーションが紛れ込んでいたら保険として除外(without_genresの
          // すり抜け対策)。genre 16が付いていない実例(TMDb側のタグ漏れ)も
          // あったため、"anime"キーワードでも二重にチェックする。
          if (genreIds.includes(16) || keywordNames.includes("anime")) {
            skipped.push({ tmdb_id: c.id, title: c.name, reason: "animation_genre" });
            return null;
          }
          // TMDbのTV用ジャンル一覧には「恋愛(Romance)」が存在しない
          // (genre id 10749はmovie専用で、/discover/tvや/tv/{id}には
          // 絶対に返ってこない)。このためGENRE_MAPに10749を書いていても
          // 恋愛系ドラマが一件も「恋愛」ジャンルにならない実害があった
          // (オーナー指摘:「恋愛もので調べても全然ヒットしない」。実例:
          // 2026-10時点でドラマ7402件中「恋愛」はわずか2件)。代わりに
          // TMDbのキーワード(keywordNames、英語)に恋愛を示す語があれば
          // 「恋愛」ジャンル・タグを補う(完璧な網羅は狙わないが、何も
          // 無いよりは大きく改善する)。
          const hasRomanceKeyword = keywordNames.some((k) =>
            k.includes("romance") || k.includes("romantic") || k.includes("love triangle")
            || k.includes("arranged marriage") || k.includes("unrequited love") || k === "love");

          const emotionTags = pickEmotionTags(genreIds);
          if (hasRomanceKeyword) {
            (GENRE_MAP[10749]?.tags || []).forEach((t) => {
              if (!emotionTags.includes(t) && emotionTags.length < 3) emotionTags.push(t);
            });
          }
          if (emotionTags.length === 0) {
            skipped.push({ tmdb_id: c.id, title: c.name, reason: "no_genre_mapping" });
            return null;
          }
          const genreNames = genreIds.map((id) => GENRE_MAP[id]?.ja).filter(Boolean);
          if (hasRomanceKeyword && !genreNames.includes("恋愛")) genreNames.push("恋愛");

          const directors = (details.created_by || []).map((p: any) => p.name);
          const cast = (credits?.cast || []).slice(0, 5).map((p: any) => p.name);

          const title = details.name || c.name;
          const dateStr = details.first_air_date;
          const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

          let overviewJa = details.overview || "";
          if (!overviewJa) {
            const detailsEn = await tmdbFetch(`/tv/${c.id}`, { language: "en-US" });
            if (detailsEn?.overview) overviewJa = await translateToJa(detailsEn.overview);
          }
          const synopsis = overviewJa.slice(0, SYNOPSIS_MAX_LEN);

          const countries: string[] = (details.origin_country || (details.production_countries || []).map((co: any) => co.iso_3166_1))
            .map((iso: string) => countryNameJa(iso, iso));

          const originCountries: string[] = details.origin_country || [];
          const japanReleaseDate = originCountries.includes("JP") ? (dateStr || null) : null;

          const keywords = (keywordsRes?.results || []).slice(0, 15).map((k: any) => k.name);

          return {
            title,
            release_year: year,
            emotion_tags: emotionTags,
            genre: genreNames.length ? genreNames : null,
            director: directors.join("、") || null,
            cast_members: cast.length ? cast : null,
            country: countries.length ? countries.join("・") : null,
            synopsis: synopsis || null,
            poster_path: details.poster_path || null,
            japan_release_date: japanReleaseDate,
            japan_release_checked_at: new Date().toISOString(),
            keywords: keywords.length ? keywords : null,
            keywords_checked_at: new Date().toISOString(),
            series: null,
            series_checked_at: null,
            tmdb_id: c.id,
            media_type: "tv",
            is_anime: false,
            is_drama: true,
            tmdb_vote_count: c.vote_count,
            tmdb_vote_average: c.vote_average,
          };
        }),
      );
      chunkRows.forEach((r) => { if (r) rows.push(r); });
      await sleep(150);
    }

    let inserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ tmdb_vote_count, tmdb_vote_average, ...rest }) => rest);
      const { error: insertErr } = await supabase.from("movies").insert(insertPayload);
      if (insertErr) throw insertErr;
      inserted = insertPayload.length;
    }

    return new Response(
      JSON.stringify({
        dry_run,
        candidates_fetched: candidates.length,
        duplicates_skipped: candidates.length - fresh.length,
        no_genre_mapping_skipped: skipped.length,
        would_insert: rows.length,
        inserted,
        rows,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err), details: err?.details, hint: err?.hint, code: err?.code }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

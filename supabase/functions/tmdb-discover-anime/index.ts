import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-discover-moviesと同じ枠組みで、アニメ(劇場版・OVAだけでなくTVシリーズも)を
// 専用に取り込む。genre_id=16(アニメーション)+ TMDbの「アニメ」キーワード
// (id: 210024)で絞ることで、国を問わずアニメ的な作品を対象にしつつ、
// Pixar/Disneyのような西洋のアニメーション作品は混ざらないようにする
// (中国・韓国などのアニメ風作品(ドンファ等)も対象に含める、というオーナーの
// 方針転換を反映)。media(movie|tv)で対象を切り替え、moviesテーブルの
// media_type/is_animeに反映する。表現度(成人向け・過激な内容)は実写と
// 同じ基準で扱う方針のため、ここでは絞り込まない。
const GENRE_MAP: Record<number, { ja: string; tags: string[] }> = {
  28: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
  12: { ja: "アドベンチャー", tags: ["ワクワク", "美しい"] },
  16: { ja: "アニメーション", tags: ["楽しい", "ワクワク", "美しい"] },
  35: { ja: "コメディ", tags: ["楽しい", "笑い"] },
  80: { ja: "クライム", tags: ["ドキドキ", "考えさせられる"] },
  99: { ja: "ドキュメンタリー", tags: ["考えさせられる"] },
  18: { ja: "ドラマ", tags: ["感動", "悲しい", "考えさせられる"] },
  10751: { ja: "ファミリー", tags: ["楽しい", "ワクワク"] },
  14: { ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  36: { ja: "歴史", tags: ["考えさせられる", "感動"] },
  27: { ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  10402: { ja: "音楽", tags: ["感動", "楽しい"] },
  9648: { ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  10749: { ja: "恋愛", tags: ["感動", "悲しい", "美しい"] },
  878: { ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  10770: { ja: "TVムービー", tags: ["感動"] },
  53: { ja: "スリラー", tags: ["ドキドキ", "怖い"] },
  10752: { ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  37: { ja: "西部劇", tags: ["ワクワク", "ドキドキ"] },
  // TV専用ジャンルID(TMDbはmovieとtvでgenre_idが一部異なる)
  10759: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] }, // Action & Adventure
  10765: { ja: "SF", tags: ["考えさせられる", "ワクワク"] }, // Sci-Fi & Fantasy
  10768: { ja: "戦争", tags: ["悲しい", "考えさせられる"] }, // War & Politics
};

// TMDbのproduction_countries.nameはlanguage=ja-JPを指定しても英語のまま返るため、
// iso_3166_1コードから日本語名へ変換する(tmdb-discover-moviesと同じ対応表。
// 海外アニメで実際によく出てくる国だけ厚めに用意してある)。
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

// TMDbはソフトコア/ヘンタイ作品にadult:trueを付けないことが多く、adultフラグ
// だけでは実際のポルノ作品を防げない。2026-09-27に「レイプゾンビ LUST OF THE
// DEAD」シリーズやヘンタイ/エッチアニメ等、この基準でmoviesテーブルから約500件
// 削除した実例に合わせ、同じキーワード集合で取り込み時にも除外する。
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

// 480文字で単純に切り詰めると文の途中(単語の途中)で切れ、その壊れた
// 英文を翻訳した結果も途中で切れた日本語になってしまう(オーナー指摘:
// あらすじが途中で切れている作品がある)。tmdb-movie-reviewsと同じく、
// 文の区切り(. ! ?)が見つかればそこで切る。
function trimToSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}
// 日本語側をSYNOPSIS_MAX_LENで切る時も、単純なsliceだと文の途中で切れる。
// 日本語の句点(。！？)で同様に区切る。
function trimToSentenceBoundaryJa(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}

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

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

// .order()を付けずにrange()でページングすると、Postgres側の実行計画が
// リクエストごとに変わり得るため行の並び順が安定せず、既存行の一部が
// 取得できずにexistingKeysに入らないことがあった(実例: 「千と千尋の神隠し」
// が既存(id20)と同じタイトル・同じ公開年にもかかわらず取り込み判定を
// すり抜けて重複登録され、詳細画面で自分自身が「シリーズの別作品」として
// 出てしまった。オーナー指摘)。idで明示的に安定ソートして防ぐ。
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
      media = "movie", // "movie" | "tv"
      pages = [1],
      min_vote_count = 50,
      min_vote_average = 5.0,
      dry_run = true,
      sort_by = "popularity.desc",
      release_date_gte = null,
      release_date_lte = null,
      // 通常はTMDbの「アニメ」キーワード(210024)で絞るが、Family Guy・
      // Rick and Mortyのような欧米の(アニメではない)大人向けアニメーション
      // コメディも対象にしたい場合はfalseにして、このキーワード条件を外す
      // (その場合はorigin_country・min_vote_count等で別途絞り込む前提)。
      require_anime_keyword = true,
      with_origin_country = null,
    } = await req.json().catch(() => ({}));

    if (media !== "movie" && media !== "tv") {
      throw new Error("media must be 'movie' or 'tv'");
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year, tmdb_id");
    const existingKeys = new Set(
      existingRows.map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}`),
    );
    // タイトル+公開年の一致だけでなく、TMDbのidそのものでも重複判定する
    // (こちらの方が表記揺れの影響を受けず確実)。
    const existingTmdbIds = new Set(existingRows.map((r: any) => r.tmdb_id).filter((v: any) => v != null));

    // 1) TMDbのdiscoverでアニメ候補一覧を取得。
    // 以前はwith_origin_country=JPで日本作品だけに絞っていたが、方針変更で
    // 中国・韓国などの海外アニメ風作品(ドンファ等)も対象にすることになった。
    // 原産国では区別せず、TMDbの「アニメ」キーワード(id: 210024。TMDb側が
    // 作品のスタイルに対して付けているタグで、Pixar/DisneyのようなCGの
    // 西洋アニメーションには基本的に付かない)で絞ることで、国に関係なく
    // 「アニメ的な作品」だけを対象にする。genre 16(アニメーション)も
    // 引き続き併用し、二重で絞り込む。
    const discoverPath = media === "movie" ? "/discover/movie" : "/discover/tv";
    const candidates: any[] = [];
    for (const page of pages) {
      const params: Record<string, string> = {
        language: "ja-JP",
        sort_by,
        with_genres: "16",
        "vote_count.gte": String(min_vote_count),
        "vote_average.gte": String(min_vote_average),
        page: String(page),
      };
      if (require_anime_keyword) params["with_keywords"] = "210024";
      if (with_origin_country) params["with_origin_country"] = with_origin_country;
      if (media === "movie") {
        params["include_adult"] = "false";
        if (release_date_gte) params["primary_release_date.gte"] = release_date_gte;
        if (release_date_lte) params["primary_release_date.lte"] = release_date_lte;
      } else {
        if (release_date_gte) params["first_air_date.gte"] = release_date_gte;
        if (release_date_lte) params["first_air_date.lte"] = release_date_lte;
      }
      const data = await tmdbFetch(discoverPath, params);
      if (data?.results?.length) candidates.push(...data.results);
      await sleep(150);
    }

    // 2) 既存作品との重複を除外(タイトル+公開年で判定)
    const fresh = candidates.filter((c: any) => {
      const dateStr = media === "movie" ? c.release_date : c.first_air_date;
      const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;
      const title = media === "movie" ? c.title : c.name;
      const key = `${normalizeTitle(title)}|${year}`;
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
          const detailPath = media === "movie" ? `/movie/${c.id}` : `/tv/${c.id}`;
          const creditsPath = media === "movie" ? `/movie/${c.id}/credits` : `/tv/${c.id}/credits`;
          const keywordsPath = media === "movie" ? `/movie/${c.id}/keywords` : `/tv/${c.id}/keywords`;

          const [details, credits, keywordsRes] = await Promise.all([
            tmdbFetch(detailPath, { language: "ja-JP" }),
            tmdbFetch(creditsPath, { language: "ja-JP" }),
            tmdbFetch(keywordsPath, {}),
          ]);
          if (!details) return null;

          // 18禁(TMDb側のadultフラグ)は、他の絞り込みをすり抜けてきた場合の
          // 保険として、ここで明示的に除外する。include_adult:falseは
          // /discover/movieには効くが/discover/tvには無いため、特にTV側で
          // このチェックが唯一の歯止めになる。
          if (details.adult === true) {
            skipped.push({ tmdb_id: c.id, title: media === "movie" ? c.title : c.name, reason: "adult_flagged" });
            return null;
          }

          const rawKeywordNames: string[] = (media === "movie" ? (keywordsRes?.keywords || []) : (keywordsRes?.results || []))
            .map((k: any) => String(k.name || "").toLowerCase());
          if (rawKeywordNames.some((k) => ADULT_CONTENT_KEYWORDS.has(k))) {
            skipped.push({ tmdb_id: c.id, title: media === "movie" ? c.title : c.name, reason: "adult_content_keyword" });
            return null;
          }

          const genreIds: number[] = (details.genres || []).map((g: any) => g.id);

          // TMDbのTV用ジャンル一覧には「恋愛(Romance)」が存在しない
          // (genre id 10749はmovie専用で、/discover/tvや/tv/{id}には
          // 絶対に返ってこない。アニメ映画側はgenre_idsに10749が普通に
          // 入るので問題無いが、アニメのTVシリーズ側は一件も「恋愛」に
          // ならない実害があった。オーナー指摘:「恋愛もので調べても
          // 全然ヒットしない」)。代わりにTMDbのキーワード(英語)に恋愛を
          // 示す語があれば「恋愛」ジャンル・タグを補う。
          const hasRomanceKeyword = media !== "movie" && rawKeywordNames.some((k) =>
            k.includes("romance") || k.includes("romantic") || k.includes("love triangle")
            || k.includes("arranged marriage") || k.includes("unrequited love") || k === "love");

          const emotionTags = pickEmotionTags(genreIds);
          if (hasRomanceKeyword) {
            (GENRE_MAP[10749]?.tags || []).forEach((t) => {
              if (!emotionTags.includes(t) && emotionTags.length < 3) emotionTags.push(t);
            });
          }
          if (emotionTags.length === 0) {
            skipped.push({ tmdb_id: c.id, title: media === "movie" ? c.title : c.name, reason: "no_genre_mapping" });
            return null;
          }
          const genreNames = genreIds.map((id) => GENRE_MAP[id]?.ja).filter(Boolean);
          if (hasRomanceKeyword && !genreNames.includes("恋愛")) genreNames.push("恋愛");

          const directors = media === "movie"
            ? (credits?.crew || []).filter((p: any) => p.job === "Director").map((p: any) => p.name)
            : (details.created_by || []).map((p: any) => p.name);
          const cast = (credits?.cast || []).slice(0, 5).map((p: any) => p.name);

          const title = media === "movie" ? (details.title || c.title) : (details.name || c.name);
          const dateStr = media === "movie" ? details.release_date : details.first_air_date;
          const year = dateStr ? parseInt(String(dateStr).slice(0, 4), 10) : null;

          let overviewJa = details.overview || "";
          if (!overviewJa) {
            const detailsEn = await tmdbFetch(detailPath, { language: "en-US" });
            if (detailsEn?.overview) overviewJa = await translateToJa(detailsEn.overview);
          }
          const synopsis = trimToSentenceBoundaryJa(overviewJa, SYNOPSIS_MAX_LEN);

          const countries: string[] = media === "movie"
            ? (details.production_countries || []).map((co: any) => countryNameJa(co.iso_3166_1, co.name))
            : (details.origin_country || (details.production_countries || []).map((co: any) => co.iso_3166_1))
                .map((iso: string) => countryNameJa(iso, iso));

          // 海外アニメも対象になったため、TVの初放送日をそのまま日本での視聴開始日
          // とは扱えなくなった(原産国JPの場合だけ、これまで通りその日付を使う)。
          const originCountries: string[] = media === "movie"
            ? (details.production_countries || []).map((co: any) => co.iso_3166_1)
            : (details.origin_country || []);
          const japanReleaseDate = media === "movie"
            ? null
            : (originCountries.includes("JP") ? (dateStr || null) : null);

          const keywordList = media === "movie"
            ? (keywordsRes?.keywords || [])
            : (keywordsRes?.results || []);
          const keywords = keywordList.slice(0, 15).map((k: any) => k.name);

          const series = media === "movie" && details.belongs_to_collection?.name
            ? details.belongs_to_collection.name.replace(/\s*(Collection|コレクション)\s*$/i, "").trim()
            : null;

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
            japan_release_checked_at: media === "movie" ? null : new Date().toISOString(),
            keywords: keywords.length ? keywords : null,
            keywords_checked_at: new Date().toISOString(),
            series,
            series_checked_at: media === "movie" ? new Date().toISOString() : null,
            tmdb_id: c.id,
            media_type: media,
            is_anime: true,
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
      // tmdb_idは今後「話ごとの欄」でTMDbのシーズン/エピソード情報を引く鍵になるため、
      // (tmdb-discover-moviesと違って)ここでは挿入時にそのまま保持しておく。
      const insertPayload = rows.map(({ tmdb_vote_count, tmdb_vote_average, ...rest }) => rest);
      const { error: insertErr } = await supabase.from("movies").insert(insertPayload);
      if (insertErr) throw insertErr;
      inserted = insertPayload.length;
    }

    return new Response(
      JSON.stringify({
        media,
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

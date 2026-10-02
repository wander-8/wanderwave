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
  "Singer/Songwriter": ["考えさせられる", "感動"],
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
  "Blues": ["考えさせられる", "感動"],
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
  // ここに実在する分だけ割り当てる(オーナー指摘)。
  "Comedy": ["笑い"],
  "Standup Comedy": ["笑い"],
  "Death Metal/Black Metal": ["怖い"],
  "Industrial": ["怖い"],
};
const DEFAULT_TAGS = ["楽しい"];
// 音楽アルバムは基本的に低刺激。曲名・アルバム名に明示的な注意書きが
// あった場合だけ底上げする(映画等ほど過激な内容が付くジャンルではないため
// シンプルなキーワード方式のみ)。
const BASE_TIER = 15;
const HEAVY_WORDS = ["Explicit"];

const COUNTRY_NAME_JA: Record<string, string> = {
  jp: "日本", us: "アメリカ", gb: "イギリス", kr: "韓国", fr: "フランス", de: "ドイツ",
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

    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    for (const e of list) {
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

      const tags = (genreName && GENRE_TAG_MAP[genreName]) || DEFAULT_TAGS;
      const level = HEAVY_WORDS.some((w) => title.includes(w)) ? 40 : BASE_TIER;

      rows.push({
        title,
        release_year: year,
        emotion_tags: tags,
        genre: genreName ? [genreName] : null,
        director: artist,
        cast_members: null,
        country: COUNTRY_NAME_JA[country] || country,
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
      });
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ _level, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      if (insertedRows?.length) {
        const levelByTitle = new Map(rows.map((r) => [normalizeTitle(r.title), r._level]));
        const estimateRows = insertedRows
          .map((r: any) => {
            const level = levelByTitle.get(normalizeTitle(r.title));
            if (level == null) return null;
            return {
              movie_id: r.id,
              expression_level: level,
              reason_tags: [],
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

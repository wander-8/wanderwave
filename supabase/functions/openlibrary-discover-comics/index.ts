import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 漫画カテゴリはこれまで楽天ブックス(日本国内の書店API)だけを情報源にしていた
// ため、日本・中国・韓国・台湾の作品しか無く、アメコミ(マーベル/DC等)が
// 1件も無かった(オーナー指摘:「漫画の国検索、アメリカとかないけど
// どうなの？」)。Open Library(Internet Archive運営、APIキー不要・無料)の
// 書誌検索を新たな情報源にして、アメリカのグラフィックノベル/コミックも
// 取り込めるようにする。Google Books APIも検討したが、キー無しでは
// 日次クォータが0で使えなかったため採用しなかった。
const OPENLIBRARY_SEARCH = "https://openlibrary.org/search.json";
const OPENLIBRARY_WORKS = "https://openlibrary.org/works";
const OPENLIBRARY_COVERS = "https://covers.openlibrary.org/b/id";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string): Promise<any> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "WanderWave/1.0 (contact: wander-8.site)" } });
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// Open Libraryのsubject(英語の自由なタグの集まり)から、サイト内の
// 日本語ジャンル・感情タグへざっくり変換する。tmdb-discover-anime等と
// 同じく「上から順に一致したものを採用」ではなく、一致した全タグを
// 頻度順に並べて上位を使う(1作品が複数ジャンルを持つのが普通なため)。
const SUBJECT_GENRE_MAP: { keywords: string[]; ja: string; tags: string[] }[] = [
  { keywords: ["superhero"], ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
  { keywords: ["science fiction", "sci-fi", "space opera"], ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  { keywords: ["fantasy", "sword and sorcery"], ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  { keywords: ["horror", "zombies", "vampires"], ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  { keywords: ["crime", "mystery", "detective", "noir"], ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  { keywords: ["romance", "love stories"], ja: "恋愛", tags: ["感動", "美しい"] },
  { keywords: ["comedy", "humor", "humour", "satire", "parody"], ja: "コメディ", tags: ["楽しい", "笑い"] },
  { keywords: ["war", "military"], ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  { keywords: ["biography", "autobiography", "memoir"], ja: "ドキュメンタリー", tags: ["考えさせられる", "感動"] },
  { keywords: ["history", "historical"], ja: "歴史", tags: ["考えさせられる", "感動"] },
  { keywords: ["western"], ja: "西部劇", tags: ["ワクワク", "ドキドキ"] },
  { keywords: ["adventure"], ja: "アドベンチャー", tags: ["ワクワク", "美しい"] },
  { keywords: ["juvenile", "children"], ja: "ファミリー", tags: ["楽しい", "ワクワク"] },
  { keywords: ["thriller", "suspense"], ja: "スリラー", tags: ["ドキドキ", "怖い"] },
  { keywords: ["dystopia", "apocalyptic", "post-apocalyptic"], ja: "SF", tags: ["考えさせられる", "怖い"] },
  { keywords: ["drama"], ja: "ドラマ", tags: ["感動", "考えさせられる"] },
];
// どのキーワードにも一致しない作品(subjectが乏しい/一般的すぎる)でも
// 取り込み自体は諦めず、最低限の感情タグだけ付けて候補から落とさない
// (rakuten-discover-novel等の既存パイプラインと同じ方針)。
const FALLBACK_TAGS = ["ワクワク", "考えさせられる"];

function pickGenreAndTags(subjects: string[]): { genre: string[]; tags: string[] } {
  const lower = subjects.map((s) => s.toLowerCase());
  const matched = new Map<string, { ja: string; tags: string[] }>();
  for (const entry of SUBJECT_GENRE_MAP) {
    if (lower.some((s) => entry.keywords.some((k) => s.includes(k)))) {
      matched.set(entry.ja, entry);
    }
  }
  if (matched.size === 0) {
    return { genre: [], tags: FALLBACK_TAGS };
  }
  const genre = [...matched.keys()];
  const tagFreq: Record<string, number> = {};
  const tagOrder: string[] = [];
  for (const { tags } of matched.values()) {
    tags.forEach((t) => {
      if (!(t in tagFreq)) tagOrder.push(t);
      tagFreq[t] = (tagFreq[t] || 0) + 1;
    });
  }
  const tags = tagOrder.sort((a, b) => tagFreq[b] - tagFreq[a]).slice(0, 3);
  return { genre, tags };
}

// 露骨な性的・暴力表現を扱う作品は、他の取り込みパイプラインと同じ方針で
// 候補の時点で除外する(表に出さない)。
const ADULT_SUBJECT_KEYWORDS = ["erotic", "pornographic", "adult comics", "underground comix"];
function isAdultSubject(subjects: string[]): boolean {
  const lower = subjects.map((s) => s.toLowerCase());
  return ADULT_SUBJECT_KEYWORDS.some((k) => lower.some((s) => s.includes(k)));
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_WORDS = ["torture", "massacre", "mutilat", "gore", "brutal", "rape", "suicide"];
const SEXUAL_WORDS = ["erotic", "nudity", "sexual content"];
function estimateExpression(subjects: string[], synopsisEn: string): { level: number; reasonTags: string[]; basis: string } {
  const haystack = `${subjects.join(" ")} ${synopsisEn}`.toLowerCase();
  if (HEAVY_WORDS.some((w) => haystack.includes(w))) {
    return { level: TIER.INTENSE, reasonTags: ["violence"], basis: "keyword-heavy" };
  }
  if (SEXUAL_WORDS.some((w) => haystack.includes(w))) {
    return { level: TIER.STRONG, reasonTags: ["sexual"], basis: "keyword-sexual" };
  }
  return { level: TIER.LOW, reasonTags: [], basis: "default" };
}

function trimToSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}
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

function extractDescription(workJson: any): string | null {
  const d = workJson?.description;
  if (!d) return null;
  if (typeof d === "string") return d;
  if (typeof d?.value === "string") return d.value;
  return null;
}

const SYNOPSIS_MAX_LEN = 400;

Deno.serve(async (req: Request) => {
  try {
    const {
      pages = [1],
      hits = 20,
      subject = "comics",
      dry_run = true,
      // 自動の日次取り込み用。1日に入れる件数を抑えたい(「少しずつでいい」との
      // オーナー要望)ため、新規候補が見つかった順に先頭N件だけを詳細取得・
      // 挿入する。nullなら従来通り無制限。
      limit = null,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    const existingKeys = new Set(
      existingRows.map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}`),
    );

    // 1) Open Libraryのsubject検索で候補一覧を取得(英語版・comics主題のみ)。
    const candidates: any[] = [];
    for (const page of pages) {
      const url = new URL(OPENLIBRARY_SEARCH);
      url.searchParams.set("subject", subject);
      url.searchParams.set("language", "eng");
      url.searchParams.set("limit", String(hits));
      url.searchParams.set("page", String(page));
      url.searchParams.set("fields", "key,title,author_name,first_publish_year,cover_i,subject,language");
      const data = await fetchJson(url.toString());
      if (data?.docs?.length) candidates.push(...data.docs);
      await sleep(250);
    }

    // 2) 既存作品との重複を除外(タイトル+初版年で判定)。タイトルが無い・
    // 年が無い候補はそもそも判定も表示もできないため除外する。
    const fresh = candidates.filter((c: any) => {
      if (!c.title || !c.first_publish_year) return false;
      const key = `${normalizeTitle(c.title)}|${c.first_publish_year}`;
      return !existingKeys.has(key);
    });

    const limited = limit != null ? fresh.slice(0, limit) : fresh;

    // 3) 各候補の詳細(あらすじ)を取得し、挿入用の行を組み立てる。
    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    const seenInBatch = new Set<string>();
    for (const c of limited) {
      const key = `${normalizeTitle(c.title)}|${c.first_publish_year}`;
      if (seenInBatch.has(key)) { skipped.push({ title: c.title, reason: "duplicate_in_batch" }); continue; }
      seenInBatch.add(key);

      const subjects: string[] = Array.isArray(c.subject) ? c.subject : [];
      if (isAdultSubject(subjects)) { skipped.push({ title: c.title, reason: "adult_subject" }); continue; }

      const workId = String(c.key || "").replace("/works/", "");
      const workJson = workId ? await fetchJson(`${OPENLIBRARY_WORKS}/${workId}.json`) : null;
      const descriptionEn = extractDescription(workJson) || "";
      const synopsis = descriptionEn ? trimToSentenceBoundaryJa(await translateToJa(descriptionEn), SYNOPSIS_MAX_LEN) : null;

      const { genre, tags } = pickGenreAndTags(subjects);
      const authors: string[] = Array.isArray(c.author_name) ? c.author_name : [];
      const coverUrl = c.cover_i ? `${OPENLIBRARY_COVERS}/${c.cover_i}-L.jpg` : null;

      rows.push({
        title: c.title,
        release_year: c.first_publish_year,
        emotion_tags: tags,
        genre: genre.length ? genre : null,
        director: authors.length ? authors.join("、") : null,
        cast_members: null,
        country: "アメリカ",
        synopsis,
        poster_path: coverUrl,
        japan_release_date: null,
        japan_release_checked_at: null,
        keywords: subjects.length ? subjects.slice(0, 15) : null,
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "manga",
        is_anime: false,
        is_drama: false,
        is_manga: true,
        _key: key,
      });

      const est = estimateExpression(subjects, descriptionEn);
      estimates.push({ key, level: est.level, reasonTags: est.reasonTags, basis: est.basis });
      await sleep(200);
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ _key, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title, release_year");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      if (insertedRows?.length) {
        const idByKey = new Map(insertedRows.map((r: any) => [`${normalizeTitle(r.title)}|${r.release_year}`, r.id]));
        const estimateRows = estimates
          .map((e) => {
            const movieId = idByKey.get(e.key);
            if (!movieId) return null;
            return {
              movie_id: movieId,
              expression_level: e.level,
              reason_tags: e.reasonTags,
              source: `openlibrary_comics_batch(${new Date().toISOString().slice(0, 10)}):${e.basis}`,
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
        skipped: skipped.length,
        would_insert: rows.length,
        inserted,
        estimates_inserted: estimatesInserted,
        rows: dry_run ? rows : undefined,
        skipped_detail: dry_run ? skipped : undefined,
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

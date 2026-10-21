import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

const GENRE_PREFIX_MAP: Record<string, { ja: string | null; tags: string[]; baseTier: number }> = {
  "001001001": { ja: "アクション", tags: ["ワクワク", "ドキドキ"], baseTier: 15 },
  "001001002": { ja: "恋愛", tags: ["感動", "美しい"], baseTier: 15 },
  "001001003": { ja: "ドラマ", tags: ["考えさせられる", "ドキドキ"], baseTier: 40 },
  "001001004": { ja: "恋愛", tags: ["感動", "悲しい"], baseTier: 40 },
};
const DEFAULT_GENRE = { ja: null, tags: ["楽しい"], baseTier: 15 };

function genreInfoFor(booksGenreId: string | null | undefined) {
  if (!booksGenreId) return DEFAULT_GENRE;
  const first = booksGenreId.split("/")[0];
  const prefix = first.slice(0, 9);
  return GENRE_PREFIX_MAP[prefix] || DEFAULT_GENRE;
}

// オーナー指摘(2026-10-21):「恋愛って少女漫画と少年漫画で分けられると思う」。
// GENRE_PREFIX_MAPは元々Rakutenの読者対象区分(001001001〜004=少年/少女/
// 青年/レディース、booksGenreId)を内容ジャンルの既定値に流用しており、
// 内容に関わらず少女・レディース向け漫画のほとんどが「恋愛」になっていた。
// ここでは読者対象だけを別に取り直し、「恋愛」に解決された場合(既定値経由・
// CONTENT_GENRE_KEYWORDSの「恋」等のキーワード一致経由のどちらも)だけ、
// 読者対象で少女漫画/少年漫画に振り分け直す(青年は男性向けとして少年漫画、
// レディースは女性向けとして少女漫画にまとめる。要望に無い細分化はしない)。
// 読者対象が取れない場合のみ「恋愛(その他)」に落とす。他の内容ジャンル
// (アクション/ドラマ/ホラー等)やBL/GLは一切変更しない。
const DEMOGRAPHIC_PREFIX_MAP: Record<string, "少女" | "少年" | "青年" | "レディース"> = {
  "001001001": "少年",
  "001001002": "少女",
  "001001003": "青年",
  "001001004": "レディース",
};
function demographicFor(booksGenreId: string | null | undefined): string | null {
  if (!booksGenreId) return null;
  const first = booksGenreId.split("/")[0];
  const prefix = first.slice(0, 9);
  return DEMOGRAPHIC_PREFIX_MAP[prefix] || null;
}
function resolveRomanceGenre(ja: string | null, booksGenreId: string | null | undefined): string | null {
  if (ja !== "恋愛") return ja;
  const demo = demographicFor(booksGenreId);
  if (demo === "少女" || demo === "レディース") return "少女漫画";
  if (demo === "少年" || demo === "青年") return "少年漫画";
  return "恋愛(その他)";
}

const CONTENT_GENRE_KEYWORDS: { pattern: RegExp; ja: string; tags: string[] }[] = [
  { pattern: /(怪異|幽霊|呑い|呑われ|化け物|怨霊|恐怖)/, ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  { pattern: /(謎|事件|推理|探偵|犯人|密室|殺人)/, ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  { pattern: /(異世界|転生|転移|魔王|魔法使い|勇者)/, ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  { pattern: /(宇宙船|宇宙|人工知能|ロボット|近未来|タイムマシン)/, ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  { pattern: /(甲子園|部活|大会優勝|全国大会|チームメイト)/, ja: "アクション", tags: ["ワクワク", "感動"] },
  { pattern: /(ギャグ|爆笑|笑える|コメディ|ドタバタ)/, ja: "コメディ", tags: ["楽しい", "笑い"] },
  { pattern: /(恋|片思い|両思い|告白|付き合(う|い)|ラブストーリー)/, ja: "恋愛", tags: ["感動", "美しい"] },
  { pattern: /(戦争|軍隊|兵士|戦場)/, ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  { pattern: /(バトル|激突|死闘|決戦|強敵|復讐)/, ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
];
function refineGenreWithCaption(baseInfo: { ja: string | null; tags: string[]; baseTier: number }, caption: string) {
  if (!caption) return baseInfo;
  const hit = CONTENT_GENRE_KEYWORDS.find((k) => k.pattern.test(caption));
  if (!hit) return baseInfo;
  return { ja: hit.ja, tags: hit.tags, baseTier: baseInfo.baseTier };
}

const BL_TAGS = ["感動", "美しい"];
function hasBLSignal(title: string, caption: string): boolean {
  const text = `${title} ${caption}`;
  if (/[^a-zA-Z]BL[^a-zA-Z]/.test(text) || /^BL[^a-zA-Z]/.test(title)) return true;
  return /ボーイズラブ/.test(text);
}

const GL_TAGS = ["感動", "美しい"];
function hasGLSignal(title: string, caption: string): boolean {
  const text = `${title} ${caption}`;
  if (/[^a-zA-Z]GL[^a-zA-Z]/.test(text) || /^GL[^a-zA-Z]/.test(title)) return true;
  if (/ガールズラブ|レズビアン/.test(text)) return true;
  if (/百合(漫画|系|もの|カップル|ラブ|展開|要素|好き|BL|アンソロジー|作家|えっち)/.test(text)) return true;
  if (/百合[!！]/.test(text)) return true;
  return /百合$/.test(title.trim());
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_WORDS = ["惨殺", "拷問", "陵辱", "強姦", "グロテスク", "残虐", "自殺", "虐待"];
// オーナー指摘(2026-10-21):「えっちとかエロゲ、シたいって単語出てるのに
// 表で出てる作品あったから気を付けて」。「エッチ」(カタカナ)だけでは、
// 実際のあらすじでずっと多く使われるひらがな表記「えっち」や、
// 「エロゲ」「シたい」のような強い信号を一切拾えていなかった(実例:
// 「ドキドキえっちシーン収録」「エロゲ好きな美少女は〜」が表現度15=控えめ
// のまま表に出ていた)。単純な「エロ」2文字一致は「ピエロ」「ラファエロ」
// 「エロウィー」のような無関係な固有名詞を誤検出するため(実データで
// 7/9が誤検出)、意味が明確な複合語だけに絞る。
const SEXUAL_WORDS = ["性的", "ヌード", "官能", "濡れ場", "エッチ", "えっち", "シたい",
  "エロゲ", "エロい", "エロ本", "エロティック", "エロ漫画", "エロマンガ", "エロビデオ", "エログロ"];

const NON_MANGA_TITLE_PATTERNS = [
  "地球の歩き方", "シールブック", "設定資料集", "ぬり絵", "コンプリートガイド", "公式ガイドブック",
];
function isNonMangaTitle(title: string): boolean {
  return NON_MANGA_TITLE_PATTERNS.some((w) => title.includes(w));
}

// タイトル自体に「エロゲ」等が直接入っている商品があり(例:「ＶＲエロゲー
// やってたら異世界に転生したので...」)、キャプションだけを見ていると
// 見逃す(オーナー指摘で発覚)。rakuten-discover-novelのestimateExpressionは
// 既にtitleも見ていたが、manga側はcaptionのみだったため揃える。
function estimateExpression(genreId: string | null | undefined, caption: string, title: string): { level: number; reasonTags: string[]; basis: string } {
  const info = genreInfoFor(genreId);
  let level = info.baseTier;
  let basis = "genre-demographic";
  const reasons = new Set<string>();
  const text = `${title} ${caption}`;

  if (HEAVY_WORDS.some((w) => text.includes(w))) {
    level = Math.max(level, TIER.INTENSE);
    reasons.add("violence");
    basis = "keyword-heavy";
  } else if (SEXUAL_WORDS.some((w) => text.includes(w))) {
    level = Math.max(level, TIER.STRONG);
    reasons.add("sexual");
    basis = "keyword-sexual";
  }
  return { level, reasonTags: Array.from(reasons), basis };
}

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

function isGoodsIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && !/^97[89]/.test(isbn);
}

function stripTrailingEditionSuffix(title: string): string {
  return title
    .replace(/[^\s　]{1,12}(?:付き|つき|付)(特装版|限定版|愛蔵版|豪華版|初回限定版|永久愛蔵版)[\s　]*$/u, "")
    .replace(/[\s　]*(特装版|限定版|愛蔵版|豪華版|初回限定版|永久愛蔵版)[\s　]*$/u, "")
    .trim();
}

function stripVolumeSuffix(rawTitle: string): string {
  const title = stripTrailingEditionSuffix(stripRetailTags(stripBonusPrefix(rawTitle)));
  const withKanjiVolume = title.match(/^(.*?)[\s　]*[\(（]?第[0-9０-９]+[巻冊集][\)）]?\s*$/u);
  if (withKanjiVolume) return withKanjiVolume[1].trim();
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  const withMiddleVolume = title.match(/^(.+?)[\s　]+[0-9０-９]{1,3}[\s　]+\S.*$/u);
  if (withMiddleVolume) return withMiddleVolume[1].trim();
  return title.trim();
}

function extractVolumeNumber(title: string): number {
  const match = title.match(/第([0-9０-９]+)[巻冊集]|[\(（]([0-9]+)[\)）]|[\s　]([0-9]+)\s*$/);
  if (!match) return 0;
  const num = match[1] || match[2] || match[3];
  return num ? parseInt(num, 10) : 0;
}

function isBundleTitle(title: string): boolean {
  return /(全[0-9０-９]+[巻冊集]|[0-9０-９]+[-－][0-9０-９]+[巻冊][\s　]*セット|[0-9０-９]+[巻冊][\s　]*セット|完結セット)/u.test(title);
}

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

async function selectAllRows(supabase: any, table: string, columns: string, eqFilter?: [string, string]): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(columns).order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (eqFilter) query = query.eq(eqFilter[0], eqFilter[1]);
    const { data, error } = await query;
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

const SYNOPSIS_MAX_LEN = 400;

function trimToSentenceBoundaryJa(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("！"), cut.lastIndexOf("？"));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}

function looksLikeTableOfContents(text: string): boolean {
  if (!text) return false;
  const numberedLines = (text.match(/(^|\n)[0-9０-９]{1,3}[\s　]/gu) || []).length;
  return numberedLines >= 4;
}

async function recoverMangaSynopsis(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title")
    .eq("media_type", "manga")
    .or("synopsis.is.null,synopsis.eq.")
    .is("synopsis_checked_at", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        const data = await rakutenFetch({ title: m.title, hits: "5" });
        if (data === null || data?.error) {
          return { movie_id: m.id, title: m.title, found: false, transientError: true };
        }
        const items = (data?.Items || []).map((w: any) => w.Item);
        const targetTitle = normalizeTitle(m.title);
        const match =
          items.find((it: any) => normalizeTitle(stripVolumeSuffix(it.title)) === targetTitle) ||
          items.find((it: any) => normalizeTitle(it.title) === targetTitle);
        const caption = match?.itemCaption ? String(match.itemCaption).trim() : "";
        const synopsis = caption && !looksLikeTableOfContents(caption) ? trimToSentenceBoundaryJa(caption, SYNOPSIS_MAX_LEN) : null;
        if (write) {
          const update: Record<string, unknown> = { synopsis_checked_at: new Date().toISOString() };
          if (synopsis) update.synopsis = synopsis;
          await supabase.from("movies").update(update).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, found: !!synopsis, synopsis };
      }),
    );
    results.push(...chunkResults);
    await sleep(300);
  }
  return results;
}

async function recoverMangaGenre(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title")
    .eq("media_type", "manga")
    .is("genre", null)
    .is("genre_checked_at", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        const data = await rakutenFetch({ title: m.title, hits: "5" });
        if (data === null || data?.error) {
          return { movie_id: m.id, title: m.title, found: false, transientError: true };
        }
        const items = (data?.Items || []).map((w: any) => w.Item);
        const targetTitle = normalizeTitle(m.title);
        const match =
          items.find((it: any) => normalizeTitle(stripVolumeSuffix(it.title)) === targetTitle) ||
          items.find((it: any) => normalizeTitle(it.title) === targetTitle);
        if (!match) {
          if (write) await supabase.from("movies").update({ genre_checked_at: new Date().toISOString() }).eq("id", m.id);
          return { movie_id: m.id, title: m.title, found: false };
        }
        const caption = match.itemCaption ? String(match.itemCaption).trim() : "";
        const baseInfo = genreInfoFor(match.booksGenreId);
        const hasBL = hasBLSignal(m.title, caption);
        const hasGL = hasGLSignal(m.title, caption);
        const genreInfo = refineGenreWithCaption(baseInfo, caption);
        const resolvedJa = resolveRomanceGenre(genreInfo.ja, match.booksGenreId);
        const genreNames = resolvedJa ? [resolvedJa] : [];
        if (hasBL && !genreNames.includes("BL")) genreNames.push("BL");
        if (hasGL && !genreNames.includes("GL")) genreNames.push("GL");
        const emotionTags = hasBL
          ? Array.from(new Set([...genreInfo.tags, ...BL_TAGS])).slice(0, 3)
          : hasGL
          ? Array.from(new Set([...genreInfo.tags, ...GL_TAGS])).slice(0, 3)
          : genreInfo.tags;
        if (write) {
          const update: Record<string, unknown> = { genre_checked_at: new Date().toISOString() };
          if (genreNames.length) {
            update.genre = genreNames;
            update.emotion_tags = emotionTags;
          }
          await supabase.from("movies").update(update).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, found: genreNames.length > 0, genre: genreNames };
      }),
    );
    results.push(...chunkResults);
    await sleep(300);
  }
  return results;
}

// recoverRomanceDemographic専用のタイトル一致判定。既存のstripVolumeSuffix+
// normalizeTitleは「かぐや様は告らせたい 17 〜天才たちの恋愛頭脳戦〜」のような
// 「巻数+サブタイトル」構成だとサブタイトルも巻数と一緒に削ってしまい
// (withMiddleVolumeが最初の数字以降を全部切り落とす)、DB側の全文タイトル
// 「かぐや様は告らせたい～天才たちの恋愛頭脳戦～」と一致しなくなる。さらに
// 全角チルダ(～ U+FF5E)と波ダッシュ(〜 U+301C)の表記差でも一致しなくなる
// (実例で確認: 最初の試行では56%が巻数・チルダ差だけで不一致になり
// 「恋愛(その他)」に落ちていた)。読者対象はシリーズ単位で共通なので巻数の
// 厳密な一致は不要と判断し、数字・空白・チルダ差を無視した比較に変える。
function normalizeForDemographicMatch(t: string): string {
  return (t || "")
    .replace(/[～〜~]/g, "〜")
    .replace(/[0-9０-９]/g, "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

// オーナー指摘(2026-10-21):「恋愛って少女漫画と少年漫画で分けられると思う」
// への対応。既にgenre=['恋愛']が入っている行を対象に、Rakutenへタイトルで
// 再照合して読者対象を取り直し、resolveRomanceGenreで少女漫画/少年漫画/
// 恋愛(その他)に置き換える。毎回同じWHERE(genre @> ARRAY['恋愛']のみ)で
// 問い合わせるため、処理が終わった行は次回の対象から自然に外れる
// (チェック用の専用カラムを増やさずに再実行可能にできる)。
// 注意: 以前は「恋愛(その他)」も対象に含めていたが、その他はRakuten側で
// 一致するタイトルが見つからなかった場合の確定終着点であり、同じ入力に
// 同じ照合を繰り返しても結果は変わらない。含めたままだとORDER BY id ASCの
// 先頭付近に居座り続け、まだ未処理の新しい行に処理が回らなくなる無限
// 再処理のバグになっていた(実測: 600件処理しても実際に恋愛ラベルを
// 抜けたのは249件のみ)。「恋愛(その他)」への再照合は、旧版の判定ロジック
// (タイトル一致が弱かった版)で落ちた分だけ、別途1回限りの手動スイープで
// 救済する。
async function recoverRomanceDemographic(supabase: any, limit: number, write: boolean, includeSonota: boolean) {
  let query = supabase
    .from("movies")
    .select("id, title, genre")
    .eq("media_type", "manga");
  query = includeSonota
    ? query.or("genre.cs.{恋愛},genre.cs.{恋愛(その他)}")
    : query.contains("genre", ["恋愛"]);
  const { data, error } = await query.order("id", { ascending: true }).limit(limit);
  if (error) throw error;
  const todo = data || [];

  const results: any[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        const data = await rakutenFetch({ title: m.title, hits: "5" });
        if (data === null || data?.error) {
          return { movie_id: m.id, title: m.title, resolved: false, transientError: true };
        }
        const items = (data?.Items || []).map((w: any) => w.Item);
        const targetTitle = normalizeForDemographicMatch(m.title);
        const match = items.find((it: any) => normalizeForDemographicMatch(it.title) === targetTitle);
        // 見つからない場合は読者対象を判定できないので「恋愛(その他)」に
        // 落とす(「恋愛」自体は漫画のジャンル語彙から外すため、不明なまま
        // 置いておくことはしない)。
        const resolved = match ? resolveRomanceGenre("恋愛", match.booksGenreId) : "恋愛(その他)";
        const genre = (m.genre || []).filter((g: string) => g !== "恋愛" && g !== "恋愛(その他)");
        if (resolved && !genre.includes(resolved)) genre.push(resolved);
        if (write) {
          await supabase.from("movies").update({ genre }).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, resolved: true, genre, matched: !!match };
      }),
    );
    results.push(...chunkResults);
    await sleep(300);
  }
  return results;
}

Deno.serve(async (req: Request) => {
  try {
    const {
      pages = [1],
      hits = 30,
      sort = "sales",
      books_genre_id = "001001",
      dry_run = true,
      limit = null,
      target = "discover",
      offset = 0,
      write = false,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (target === "recover_synopsis") {
      const results = await recoverMangaSynopsis(supabase, offset, limit ?? 30, write);
      return new Response(JSON.stringify({ offset, limit, write, processed: results.length, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (target === "recover_genre") {
      const results = await recoverMangaGenre(supabase, offset, limit ?? 30, write);
      return new Response(JSON.stringify({ offset, limit, write, processed: results.length, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (target === "recover_romance_demographic") {
      const results = await recoverRomanceDemographic(supabase, limit ?? 30, write, false);
      return new Response(JSON.stringify({ limit, write, processed: results.length, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 旧版(タイトル一致が弱い版)で「恋愛(その他)」に落ちてしまった分だけを
    // 新しい照合ロジックで1回だけ救済し直すための専用ターゲット。
    // recover_romance_demographic本体はその他を対象から外しているため
    // (無限再処理バグの修正、上のコメント参照)、この救済だけ別経路にする。
    if (target === "recover_romance_sonota_resweep") {
      const results = await recoverRomanceDemographic(supabase, limit ?? 30, write, true);
      return new Response(JSON.stringify({ limit, write, processed: results.length, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year", ["media_type", "manga"]);
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
    const limited = limit != null ? fresh.slice(0, limit) : fresh;

    const now = new Date();
    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    for (const { key, item } of limited) {
      if (isNonMangaTitle(item.title)) {
        skipped.push({ key, reason: "non_manga_title" });
        continue;
      }
      if (isBundleTitle(item.title)) {
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
      const resolvedJa = resolveRomanceGenre(genreInfo.ja, item.booksGenreId);
      const hasBL = hasBLSignal(item.title, caption);
      const hasGL = hasGLSignal(item.title, caption);
      const genreNames = resolvedJa ? [resolvedJa] : [];
      if (hasBL && !genreNames.includes("BL")) genreNames.push("BL");
      if (hasGL && !genreNames.includes("GL")) genreNames.push("GL");
      const emotionTags = hasBL
        ? Array.from(new Set([...genreInfo.tags, ...BL_TAGS])).slice(0, 3)
        : hasGL
        ? Array.from(new Set([...genreInfo.tags, ...GL_TAGS])).slice(0, 3)
        : genreInfo.tags;
      const year = saleDate ? saleDate.getUTCFullYear() : null;
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
        emotion_tags: emotionTags,
        genre: genreNames.length ? genreNames : null,
        director: item.author || null,
        cast_members: null,
        country: "日本",
        synopsis: caption && !looksLikeTableOfContents(caption) ? trimToSentenceBoundaryJa(caption, SYNOPSIS_MAX_LEN) : null,
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

      const est = estimateExpression(item.booksGenreId, caption, item.title);
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

        // オーナー指摘(2026-10-22、design spec コンポーネントA-4):Rakuten分は
        // AniList/TMDBのような既製の細かいタグが無いため、ここでcontent-classify
        // を呼んでniche_tagsを埋める。失敗してもinsert自体(新規作品の取り込み)は
        // 既に完了しているので影響しない(.catchで握り潰す)。
        const classifyItems = rows
          .map((r) => {
            const movieId = idByTitle.get(normalizeTitle(r._key));
            return movieId ? { movie_id: movieId, synopsis: r.synopsis || "" } : null;
          })
          .filter(Boolean);
        if (classifyItems.length) {
          await fetch(`${SUPABASE_URL}/functions/v1/content-classify`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` },
            body: JSON.stringify({ items: classifyItems, write: true }),
          }).catch((err) => console.error("content-classify呼び出しに失敗しました", err));
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

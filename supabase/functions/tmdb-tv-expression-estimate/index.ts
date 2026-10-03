import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-expression-estimateのTV版。実際の投票が無い作品は表現度ゲージが
// 0(=「控えめ」の位置)にデフォルト表示されてしまい、これはTVアニメの
// ように未評価の作品が一気に増える場合に特に誤解を招く(過激な内容の
// 作品でも見た目は「控えめ」になってしまう)。movie_expression_estimatesに
// 推定値を先回りで入れておくことで、実際の投票が集まるまでの間の表示を
// 実データに基づいたものにする。
//
// 映画版と違い、TVはTMDb側に日本のレーティングがほぼ登録されておらず、
// 使える年齢区分は米国のTV Parental Guidelines(TV-Y〜TV-MA)くらいしか
// 無いことが多い。加えて、こちらはmoviesテーブルに既にtmdb_idと
// keywords(tmdb-discover-animeが取り込み時に保存済み)があるので、
// 検索をせずそれらをそのまま使い、性的表現に関するTMDbキーワード
// (ecchi/hentai等)が付いている場合はレーティングが無くても底上げする。

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };

const TV_CERT_MAP: Record<string, Record<string, number>> = {
  US: { "TV-Y": TIER.LOW, "TV-Y7": TIER.LOW, "TV-G": TIER.LOW, "TV-PG": TIER.LOW, "TV-14": TIER.MILD, "TV-MA": TIER.STRONG },
};
const CERT_COUNTRY_PRIORITY = ["US"];

const GENRE_FEAR = new Set([27, 53, 9648, 10765]);
const GENRE_VIOLENCE = new Set([28, 80, 10752, 53, 10759]);
const GENRE_SEXUAL = new Set([10749]);
const GENRE_HEAVY = new Set([27, 53, 80, 10752, 28, 10759]);

const SEXUAL_KEYWORDS = ["ecchi", "hentai", "nudity", "erotic", "fanservice", "panty shot", "sex"];
const HEAVY_KEYWORDS = ["gore", "torture", "brutal violence", "sexual violence", "rape"];

function keywordBoost(keywords: string[]): { tier: number | null; tags: Set<string> } {
  const lower = keywords.map((k) => k.toLowerCase());
  const tags = new Set<string>();
  let tier: number | null = null;
  if (lower.some((k) => HEAVY_KEYWORDS.some((w) => k.includes(w)))) {
    tier = TIER.INTENSE;
    tags.add("violence");
    tags.add("sexual");
  } else if (lower.some((k) => SEXUAL_KEYWORDS.some((w) => k.includes(w)))) {
    tier = TIER.STRONG;
    tags.add("sexual");
  }
  return { tier, tags };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
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

function pickCertification(results: any[]): { cert: string; country: string } | null {
  for (const country of CERT_COUNTRY_PRIORITY) {
    const entry = results?.find((r: any) => r.iso_3166_1 === country);
    if (entry?.rating) return { cert: entry.rating, country };
  }
  return null;
}

function scoreShow(opts: { cert: { cert: string; country: string } | null; genreIds: number[]; keywords: string[] }) {
  let tier: number;
  let basis: string;

  if (opts.cert) {
    const map = TV_CERT_MAP[opts.cert.country] || {};
    tier = map[opts.cert.cert] ?? TIER.MILD;
    basis = `cert:${opts.cert.country}:${opts.cert.cert}`;
  } else {
    const heavy = opts.genreIds.some((g) => GENRE_HEAVY.has(g));
    tier = heavy ? TIER.MILD : TIER.LOW;
    basis = heavy ? "fallback:genre-heavy" : "fallback:genre-light";
  }

  let tags = new Set<string>();
  const kw = keywordBoost(opts.keywords);
  if (kw.tier != null && kw.tier > tier) {
    tier = kw.tier;
    basis += "+keyword";
  }
  kw.tags.forEach((t) => tags.add(t));

  if (tier > TIER.LOW) {
    if (opts.genreIds.some((g) => GENRE_FEAR.has(g))) tags.add("fear");
    if (opts.genreIds.some((g) => GENRE_VIOLENCE.has(g))) tags.add("violence");
    if (opts.genreIds.some((g) => GENRE_SEXUAL.has(g)) && tier >= TIER.MILD) tags.add("sexual");
  } else {
    tags = new Set();
  }

  return { expression_level: tier, reason_tags: Array.from(tags), basis };
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 50, persist = false } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: movies, error } = await supabase
      .from("movies")
      .select("id, title, release_year, genre, keywords, tmdb_id")
      .eq("media_type", "tv")
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    const existing = await selectAllRows(supabase, "movie_expression_estimates", "movie_id");
    const existingIds = new Set(existing.map((e: any) => e.movie_id));
    const todo = (movies || []).filter((m: any) => !existingIds.has(m.id));

    const results: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const keywords = m.keywords || [];
          if (!m.tmdb_id) {
            return {
              movie_id: m.id,
              title: m.title,
              tmdb_matched: false,
              ...scoreShow({ cert: null, genreIds: [], keywords }),
            };
          }
          const [contentRatings, details] = await Promise.all([
            tmdbFetch(`/tv/${m.tmdb_id}/content_ratings`, {}),
            tmdbFetch(`/tv/${m.tmdb_id}`, { language: "ja-JP" }),
          ]);
          const cert = pickCertification(contentRatings?.results || []);
          const genreIds = (details?.genres || []).map((g: any) => g.id);
          const scored = scoreShow({ cert, genreIds, keywords });
          return {
            movie_id: m.id,
            title: m.title,
            tmdb_matched: true,
            tmdb_id: m.tmdb_id,
            certification: cert ? `${cert.country}:${cert.cert}` : null,
            ...scored,
          };
        }),
      );
      results.push(...chunkResults);
      await sleep(150);
    }

    let inserted = 0;
    if (persist && results.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const rows = results.map((r: any) => ({
        movie_id: r.movie_id,
        expression_level: r.expression_level,
        reason_tags: r.reason_tags,
        source: `tmdb_tv_batch(${today}):${r.basis}${r.tmdb_id ? `;tmdb_id=${r.tmdb_id}` : ""}`,
        method: "rating_mapping",
      }));
      const { error: upsertErr, count } = await supabase
        .from("movie_expression_estimates")
        .upsert(rows, { onConflict: "movie_id", ignoreDuplicates: true, count: "exact" });
      if (upsertErr) throw upsertErr;
      inserted = count ?? rows.length;
      return new Response(JSON.stringify({ offset, limit, processed: todo.length, inserted }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ offset, limit, processed: todo.length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

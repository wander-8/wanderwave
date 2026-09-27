import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

const GENRE_PREFIX_MAP = new Set([
  "001004001", "001004002", "001004008", "001004009", "001004016", "001017005", "001017006",
]);
const FICTION_CATCHALL_PREFIXES = new Set(["001004015", "001017004"]);
const EXCLUDED_TOP_PREFIXES = new Set([
  "001002", "001003", "001005", "001006", "001007", "001008", "001009", "001010",
  "001012", "001013", "001016", "001018", "001026", "001027", "001028",
]);

function genreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").map((s) => s.slice(0, 9)).filter(Boolean);
}
function isFictionCandidate(booksGenreId: string | null | undefined): boolean {
  const segs = genreSegments(booksGenreId);
  if (segs.some((s) => GENRE_PREFIX_MAP.has(s))) return true;
  if (!segs.some((s) => FICTION_CATCHALL_PREFIXES.has(s))) return false;
  return !segs.some((s) => EXCLUDED_TOP_PREFIXES.has(s.slice(0, 6)));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rakutenFetchByTitleAndIsbn(title: string, isbn: string) {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  url.searchParams.set("title", title);
  url.searchParams.set("isbnjan", isbn);
  url.searchParams.set("hits", "30");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString(), { headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") } });
      if (res.ok) return await res.json();
      if (res.status === 429) { await sleep(1200); continue; }
      return null;
    } catch { await sleep(500); }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 35 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: novels, error: novelsErr } = await supabase
      .from("movies")
      .select("id, title, genre")
      .eq("is_novel", true)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (novelsErr) throw novelsErr;

    const { count: totalRemaining } = await supabase
      .from("movies")
      .select("id", { count: "exact", head: true })
      .eq("is_novel", true)
      .gt("id", after_id);

    const ids = novels.map((n: any) => n.id);
    const { data: estimates, error } = await supabase
      .from("movie_expression_estimates")
      .select("movie_id, source")
      .in("movie_id", ids)
      .like("source", "rakuten_novel_batch%");
    if (error) throw error;

    const titleById = new Map(novels.map((n: any) => [n.id, n.title]));
    const targets = estimates
      .map((e: any) => {
        const m = String(e.source).match(/isbn=([0-9Xx]+)/);
        return { movie_id: e.movie_id, isbn: m ? m[1] : null, title: titleById.get(e.movie_id) };
      })
      .filter((t: any) => t.isbn && t.title);

    const results: any[] = [];
    for (const t of targets) {
      const data: any = await rakutenFetchByTitleAndIsbn(t.title, t.isbn);
      const items = (data?.Items || []).map((w: any) => w.Item);
      const item = items.find((it: any) => it.isbn === t.isbn) || null;
      const genreId = item?.booksGenreId || null;
      const keep = item ? isFictionCandidate(genreId) : true;
      results.push({ movie_id: t.movie_id, title: t.title, isbn: t.isbn, genreId, found: !!item, keep });
      await sleep(250);
    }

    const toDelete = results.filter((r) => !r.keep).map((r) => r.movie_id);
    let deleted = 0;
    if (!dry_run && toDelete.length) {
      await supabase.from("movie_expression_estimates").delete().in("movie_id", toDelete);
      const { error: delErr, count } = await supabase.from("movies").delete({ count: "exact" }).in("id", toDelete);
      if (delErr) throw delErr;
      deleted = count ?? toDelete.length;
    }

    const nextAfterId = novels.length ? novels[novels.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        total_remaining_before_this_batch: totalRemaining,
        after_id,
        next_after_id: nextAfterId,
        batch_size: novels.length,
        checked: results.length,
        not_found: results.filter((r: any) => !r.found).length,
        would_delete: toDelete.length,
        deleted,
        deleted_titles: novels.filter((n: any) => toDelete.includes(n.id)).map((n: any) => n.title),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), { status: 500 });
  }
});

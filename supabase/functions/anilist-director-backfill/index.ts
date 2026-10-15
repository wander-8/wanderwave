import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー指摘:「監督情報がない作品多いけど入れられてる?」。実データ確認で
// 判明:映画/本/漫画/音楽はほぼ埋まっているが、ドラマ62%・アニメ37%と
// TV形式だけ大きく欠けている。原因はTMDB discover系(tmdb-discover-anime等)が
// TV形式には「監督」ではなく`created_by`(制作者寄り、原作付きアニメ等では
// 空のことが多い)を代用しているため。アニメはAniList(既にanilist-discover-
// manga で漫画取り込みに使っている無料・無認証・90req/minのGraphQL API)の
// 方がstaffにDirector役職を持っていることが多いので、そちらで埋め直す
// (ドラマはAniList対象外、良い代替ソースが無いため今回は対象外のまま)。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANILIST_ENDPOINT = "https://graphql.anilist.co";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const QUERY = `
query ($search: String) {
  Page(page: 1, perPage: 5) {
    media(search: $search, type: ANIME, isAdult: false) {
      id
      title { romaji english native }
      staff(perPage: 10) { edges { role node { name { full } } } }
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
      const body = await res.text();
      return { error: true, status: res.status, body };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// タイトルの表記ゆれ(全角/半角・記号・空白)を緩く正規化して比較する。
// synopsis-backfillと同じく「タイトルが実質一致するものだけ信頼する」
// 方針(誤って別作品の監督情報を拾わないため)。
function normalizeTitle(t: string): string {
  return (t || "")
    .trim()
    .toLowerCase()
    .replace(/[\s　:：・\-－!！?？.,、。]/g, "");
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 20 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title")
      .eq("is_anime", true)
      .or("director.is.null,director.eq.")
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const results: any[] = [];
    for (const r of rows || []) {
      const targetNorm = normalizeTitle(r.title);
      const data: any = await anilistFetch({ search: r.title });
      await sleep(350); // AniListは90req/min、余裕を持って1秒あたり2件未満のペースにする

      if (!data || data.error) {
        results.push({ id: r.id, title: r.title, error: data?.status || "fetch_failed" });
        continue;
      }
      const candidates = data?.data?.Page?.media || [];
      let director: string | null = null;
      let matchedTitle: string | null = null;
      for (const c of candidates) {
        const titleVariants = [c.title?.romaji, c.title?.english, c.title?.native].filter(Boolean);
        if (!titleVariants.some((t: string) => normalizeTitle(t) === targetNorm)) continue;
        // 「ADR Director」「Dubbing Director」は英語吹替版の収録監督(=声優
        // キャスティング側の役職)で、アニメ本編の監督ではない。実機確認で、
        // 除外せずに拾うとBLEACHで英語版声優の名前が「監督」として入って
        // しまう事故が起きた(Wendee Lee等)。ADR/Dub系・話数監督・助監督を
        // 除いた「Director」「Chief Director」「Series Director」だけを拾う。
        const directorStaff = (c.staff?.edges || [])
          .filter((e: any) => {
            const role = e.role || "";
            if (!/director/i.test(role)) return false;
            return !/adr|dub|assistant|episode|sound|art|animation|photography|voice/i.test(role);
          })
          .map((e: any) => e.node?.name?.full)
          .filter(Boolean);
        if (directorStaff.length) {
          director = [...new Set(directorStaff)].slice(0, 3).join("、");
          matchedTitle = titleVariants[0];
          break;
        }
      }

      results.push({ id: r.id, title: r.title, found: !!director, director, matchedTitle });
      if (director && !dry_run) {
        const { error: updErr } = await supabase.from("movies").update({ director }).eq("id", r.id);
        if (updErr) throw updErr;
      }
    }

    const lastCheckedId = rows && rows.length ? rows[rows.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        scanned_rows: rows?.length || 0,
        filled: results.filter((r) => r.found).length,
        next_after_id: lastCheckedId,
        exhausted: (rows?.length || 0) < limit,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), { status: 500 });
  }
});

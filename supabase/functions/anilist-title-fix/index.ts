import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANILIST_ENDPOINT = "https://graphql.anilist.co";

function looksJapaneseText(s: string): boolean {
  return /[぀-ヿ㐀-鿿]/.test(s);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const QUERY = `
query ($search: String) {
  Media(search: $search, type: MANGA) {
    title { romaji english native }
    countryOfOrigin
  }
}`;

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

async function anilistSearch(title: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(ANILIST_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { search: title } }),
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }
      return null;
    } catch {
      await sleep(500);
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 30 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title")
      .eq("is_manga", true)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(400);
    if (error) throw error;

    const asciiAll = rows.filter((r: any) => /^[A-Za-z0-9 :'\-.,!?&]+$/.test(r.title));
    const asciiOnly = asciiAll.slice(0, limit);

    const results: any[] = [];
    for (const r of asciiOnly) {
      const data: any = await anilistSearch(r.title);
      const media = data?.data?.Media;
      const native = media?.title?.native;
      const isJP = media?.countryOfOrigin === "JP";
      const isSameWork = [media?.title?.english, media?.title?.romaji].some(
        (t: string | null | undefined) => t && normalize(t) === normalize(r.title),
      );
      const shouldRename = isSameWork && isJP && native && looksJapaneseText(native) && native !== r.title;
      results.push({ id: r.id, oldTitle: r.title, native: native || null, countryOfOrigin: media?.countryOfOrigin || null, matched: isSameWork, willRename: !!shouldRename });
      if (shouldRename && !dry_run) {
        const { error: updErr } = await supabase.from("movies").update({ title: native }).eq("id", r.id);
        if (updErr) throw updErr;
      }
      await sleep(700);
    }

    const lastCheckedId = asciiOnly.length ? asciiOnly[asciiOnly.length - 1].id : (rows.length ? rows[rows.length - 1].id : after_id);

    return new Response(
      JSON.stringify({
        scanned_rows: rows.length,
        ascii_checked: asciiOnly.length,
        renamed: results.filter((r) => r.willRename).length,
        next_after_id: lastCheckedId,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), { status: 500 });
  }
});

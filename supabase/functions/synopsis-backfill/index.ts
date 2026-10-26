import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";
const SYNOPSIS_MAX_LEN = 400;

// カタログ代表(最も若い巻)としてまとめた1件が、たまたまitemCaptionの
// 無い巻だったためあらすじが空のままの作品がある。同じシリーズの別の巻に
// あらすじが付いていることが多いので、タイトルで再検索し、巻数違い等を
// 取り除いた上で「元のタイトルと完全一致するシリーズの、キャプション付きの
// 巻」を見つけたときだけ、そのキャプションを採用する。ジャンルではなく
// 「タイトル完全一致」を信頼の根拠にしているため、誤って別作品のあらすじを
// 拾ってしまう心配がない。
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
function stripBundleCountSuffix(title: string): string {
  return title
    .replace(/[\s　]*[\(（]?全[0-9０-９]+[巻冊集][\)）]?(セット|箱入り[^\s　]*)?\s*$/u, "")
    .replace(/[\s　]*[0-9０-９]+[巻冊][\s　]*セット\s*$/u, "")
    .replace(/[\s　]*[\(（][0-9０-９]+冊[\)）]\s*$/u, "")
    .trim();
}
function stripVolumeSuffix(rawTitle: string): string {
  const title = stripBundleCountSuffix(stripRetailTags(stripBonusPrefix(rawTitle)));
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  return title.trim();
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

Deno.serve(async (req: Request) => {
  try {
    const {
      dry_run = true,
      after_id = 0,
      limit = 20,
      media_type = "manga", // "manga" | "novel"
    } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const flagCol = media_type === "novel" ? "is_novel" : "is_manga";
    const booksGenreId = media_type === "novel" ? "001004" : "001001";

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title")
      .eq(flagCol, true)
      .or("synopsis.is.null,synopsis.eq.")
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (error) throw error;

    const results: any[] = [];
    for (const r of rows || []) {
      const data: any = await rakutenFetch({ booksGenreId, title: r.title, hits: "10", sort: "sales" });
      await sleep(400);
      if (data?.error) {
        results.push({ id: r.id, title: r.title, error: data.status });
        continue;
      }
      const items = (data?.Items || []).map((w: any) => w.Item);
      const targetNorm = normalizeTitle(r.title);
      let caption: string | null = null;
      for (const item of items) {
        if (normalizeTitle(stripVolumeSuffix(item.title)) !== targetNorm) continue;
        const c = (item.itemCaption || "").trim();
        if (c) {
          caption = c.slice(0, SYNOPSIS_MAX_LEN);
          break;
        }
      }
      results.push({ id: r.id, title: r.title, found: !!caption, synopsis: caption });
      if (caption && !dry_run) {
        const { error: updErr } = await supabase.from("movies").update({ synopsis: caption }).eq("id", r.id);
        if (updErr) throw updErr;
      }
    }

    const lastCheckedId = rows && rows.length ? rows[rows.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        media_type,
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

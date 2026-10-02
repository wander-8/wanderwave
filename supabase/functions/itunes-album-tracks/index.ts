import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function itunesFetch(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(400 * (attempt + 1));
    }
  }
  return null;
}

function normalize(t: string): string {
  return (t || "").trim().toLowerCase().replace(/[:\-'".,!?&]/g, "").replace(/\s+/g, " ");
}

// アルバム検索。countryを指定しない場合iTunes検索はUSストアのみを見るため、
// 日本限定リリースのアルバム(邦楽・アニメ/ドラマ主題歌集など)が軒並み
// ヒットせず「試聴ボタンが出ない」事故につながっていた。まずJPストアで
// 探し、見つからなければUSストア(country省略)にフォールバックする。
async function searchAlbum(title: string, artist: string, country: string | null) {
  const searchUrl = new URL("https://itunes.apple.com/search");
  searchUrl.searchParams.set("term", `${artist} ${title}`.trim());
  searchUrl.searchParams.set("entity", "album");
  searchUrl.searchParams.set("limit", "10");
  if (country) searchUrl.searchParams.set("country", country);
  const searchData = await itunesFetch(searchUrl.toString());
  return (searchData?.results || []) as any[];
}

function pickBest(results: any[], title: string, artist: string) {
  const wantedTitle = normalize(title);
  const wantedArtist = normalize(artist);
  let best = results.find((r: any) =>
    normalize(r.collectionName) === wantedTitle && (!artist || normalize(r.artistName) === wantedArtist)
  );
  if (!best) {
    best = results.find((r: any) => normalize(r.collectionName) === wantedTitle);
  }
  if (!best) {
    best = results.find((r: any) => !artist || normalize(r.artistName) === wantedArtist);
  }
  return best || null;
}

Deno.serve(async (req: Request) => {
  try {
    const { movie_id } = await req.json().catch(() => ({}));
    if (!movie_id) throw new Error("movie_id is required");

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: movie, error } = await supabase
      .from("movies")
      .select("title, director, is_music")
      .eq("id", movie_id)
      .single();
    if (error) throw error;
    if (!movie?.is_music) throw new Error("not a music album");

    const title = movie.title as string;
    const artist = (movie.director as string) || "";

    let country: string | null = "jp";
    let results = await searchAlbum(title, artist, country);
    let best = pickBest(results, title, artist);
    if (!best) {
      country = null;
      results = await searchAlbum(title, artist, country);
      best = pickBest(results, title, artist);
    }

    if (!best) {
      return new Response(JSON.stringify({ found: false, tracks: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const lookupUrl = new URL("https://itunes.apple.com/lookup");
    lookupUrl.searchParams.set("id", String(best.collectionId));
    lookupUrl.searchParams.set("entity", "song");
    if (country) lookupUrl.searchParams.set("country", country);
    const lookupData = await itunesFetch(lookupUrl.toString());
    const trackResults = (lookupData?.results || []).filter((r: any) => r.wrapperType === "track");
    // previewUrl: iTunesが提供する30秒プレビュー音源(AAC)。「開いたら音楽を
    // 聞けるようにしてほしい」という要望を受けて追加。著作権的にも、iTunes公式の
    // 試聴用音源をそのまま使うのが安全(フル楽曲の取得・配信は行わない)。
    const tracks = trackResults
      .sort((a: any, b: any) => (a.trackNumber || 0) - (b.trackNumber || 0))
      .map((t: any) => ({
        trackNumber: t.trackNumber || null,
        trackName: t.trackName || "",
        trackTimeMillis: t.trackTimeMillis || null,
        previewUrl: t.previewUrl || null,
      }));

    return new Response(
      JSON.stringify({ found: tracks.length > 0, album: best.collectionName, tracks }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

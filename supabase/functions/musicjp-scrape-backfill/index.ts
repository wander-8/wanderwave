import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    // 全作品を取得
    const { data: movies, error: moviesError } = await supabase
      .from("movies")
      .select("id, title, media_type")
      .limit(1000);

    if (moviesError) throw moviesError;

    let successCount = 0;
    let skipCount = 0;
    const results = [];

    for (const movie of movies) {
      // 既に登録済みか確認
      const { data: existing } = await supabase
        .from("service_links")
        .select("id")
        .eq("media_id", String(movie.id))
        .eq("service_name", "music.jp")
        .single();

      if (existing) {
        skipCount++;
        continue;
      }

      // music.jpで検索
      const searchUrl = `https://music-book.jp/search?q=${encodeURIComponent(movie.title)}`;

      try {
        const response = await fetch(searchUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; WanderwaveBot/1.0)",
          },
        });

        if (!response.ok) continue;

        const html = await response.text();

        // 最初のマッチした商品ページへのリンクを抽出
        // music.jpの商品ページURLパターン: /music/album/... または /comic/... など
        const urlPattern = /href="([^"]*\/(?:music|comic|novel|book|drama|movie|song)\/[^"]*?)"/;
        const match = html.match(urlPattern);

        if (match && match[1]) {
          const productUrl = match[1].startsWith("http")
            ? match[1]
            : `https://music-book.jp${match[1]}`;

          // service_linksに登録
          const { error: insertError } = await supabase
            .from("service_links")
            .insert({
              media_id: String(movie.id),
              media_type: movie.media_type,
              service_name: "music.jp",
              url: productUrl,
              active: true,
            });

          if (!insertError) {
            successCount++;
            results.push({
              id: movie.id,
              title: movie.title,
              url: productUrl,
              status: "registered",
            });
          }
        }
      } catch (e) {
        console.error(`Error scraping for ${movie.title}:`, e.message);
      }

      // レート制限対応：少し待機
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: movies.length,
        registered: successCount,
        skipped: skipCount,
        results: results.slice(0, 20), // 最初の20件のみレスポンス
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});

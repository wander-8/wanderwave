import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { judgeManga, judgeBook } from "./judge.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  try {
    // Mock AniList fetch (in production, would call real API)
    const mockManga = [
      {
        title: "Solo Leveling",
        countryOfOrigin: "KR",
        language: "Korean",
      },
      {
        title: "One Piece",
        countryOfOrigin: "JP",
        language: "Japanese",
      },
      {
        title: "Saga",
        countryOfOrigin: "US",
        language: "English",
      },
      {
        title: "Webtoon Series",
        countryOfOrigin: "KR",
        language: "Korean",
      },
    ];

    const results = [];
    for (const manga of mockManga) {
      const judgment = judgeManga(manga);

      const { error } = await supabase
        .from("catalog_review_log")
        .insert([
          {
            source: "anilist",
            type: "manga",
            title: manga.title,
            country: manga.countryOfOrigin,
            language: manga.language,
            judgment: judgment.judgment,
            judgment_reason: judgment.reason,
            judgment_confidence: judgment.confidence,
          },
        ]);

      if (error) {
        console.error("Insert error:", error);
      } else {
        results.push({ title: manga.title, judgment: judgment.judgment });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: mockManga.length,
        results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { judgeBook } from "../catalog-expand-manga/judge.ts";

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
    // Mock NDL fetch (in production, would call real API)
    const mockBooks = [
      {
        title: "The Great Gatsby",
        countryOfOrigin: "US",
        language: "en",
      },
      {
        title: "1Q84",
        countryOfOrigin: "JP",
        language: "Japanese",
      },
      {
        title: "Sapiens",
        countryOfOrigin: "IL",
        language: "en",
      },
      {
        title: "The Midnight Library",
        countryOfOrigin: "GB",
        language: "en",
      },
    ];

    const results = [];
    for (const book of mockBooks) {
      const judgment = judgeBook(book);

      const { error } = await supabase
        .from("catalog_review_log")
        .insert([
          {
            source: "ndl",
            type: "book",
            title: book.title,
            country: book.countryOfOrigin,
            language: book.language,
            judgment: judgment.judgment,
            judgment_reason: judgment.reason,
            judgment_confidence: judgment.confidence,
          },
        ]);

      if (error) {
        console.error("Insert error:", error);
      } else {
        results.push({ title: book.title, judgment: judgment.judgment });
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        processed: mockBooks.length,
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

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { items, dry_run = false } = await req.json().catch(() => ({}));

  if (!items || !Array.isArray(items)) {
    return new Response(
      JSON.stringify({ error: "items array required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    console.log(`Bulk insert: ${items.length} items, dry_run: ${dry_run}`);

    if (!dry_run) {
      const { data, error } = await supabase.from("movies").insert(items);
      if (error) throw error;
      console.log(`Inserted ${items.length} rows`);
    }

    return new Response(
      JSON.stringify({
        dry_run,
        items_count: items.length,
        inserted: !dry_run ? items.length : 0,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});

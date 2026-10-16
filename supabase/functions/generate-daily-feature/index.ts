import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー指示書(自動化パック)より:「既存の作品データと感情タグを
// 組み合わせてAIに特集を書かせる」。元は日次だったが、「今週の特集」という
// 見た目のラベルに合わせて週次に変更した(オーナー要望:「毎週新しい感情
// テーマ」)。AI呼び出しは週1回だけに絞るため、直近6.5日以内に生成済みなら
// APIを呼ばずに終了する(cronの実行時刻ズレ・手動の二重実行で無駄打ちしない
// ためのガード)。
// generate-diagnosis(診断機能)と同じ構成:Anthropic API、haikuモデル、
// tool-useで構造化出力を強制する。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// index.html側のTAG_COLORS/TAG_FACT_PHRASEと同じ10種の感情タグ語彙。
// 1日単位の切り替えだと、見た目のラベル(index.html側で既に「今週の特集」)の
// 「週替わり」感と合わなくなる(オーナー要望:「毎週新しい感情テーマ」)。
// ISO週番号相当(epoch日数を7で割った週番号)で巡回する。年境界のズレは
// 表示上「第N週」ラベルを出していないため実害が無い。
const EMOTION_TAGS = ["楽しい", "感動", "リラックス", "ワクワク", "怖い", "美しい", "ドキドキ", "笑い", "悲しい", "考えさせられる"];
const MEDIA_MODES = ["movie", "anime", "drama", "manga", "novel", "music"] as const;

function weekOfYearTag(): string {
  const weekNum = Math.floor(Date.now() / (7 * 86400000));
  return EMOTION_TAGS[weekNum % EMOTION_TAGS.length];
}

function modeOf(row: any): string {
  if (row.is_anime) return "anime";
  if (row.is_drama) return "drama";
  if (row.is_manga) return "manga";
  if (row.is_novel) return "novel";
  if (row.is_music) return "music";
  return "movie";
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };
  try {
    const { force = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (!force) {
      const { data: recent } = await supabase
        .from("automated_features")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (recent && Date.now() - new Date(recent.created_at).getTime() < 6.5 * 24 * 60 * 60 * 1000) {
        return new Response(JSON.stringify({ skipped: true, reason: "already_generated_recently", last: recent.created_at }), {
          headers: jsonHeaders,
        });
      }
    }

    const tag = weekOfYearTag();

    // あらすじが無い行はAIが共通点を書けないため対象外にする(音楽はsynopsis
    // が実質プレースホルダーしか無く、この条件でほぼ自動的に除外される)。
    const { data: movies, error } = await supabase
      .from("movies")
      .select("id, title, synopsis, genre, is_anime, is_drama, is_manga, is_novel, is_music")
      .contains("emotion_tags", [tag])
      .not("synopsis", "is", null)
      .neq("synopsis", "")
      .limit(400);
    if (error) throw error;
    if (!movies || !movies.length) {
      return new Response(JSON.stringify({ error: "no_candidates", tag }), { status: 500, headers: jsonHeaders });
    }

    const { data: stats } = await supabase.from("movie_review_stats").select("movie_id, love_sum, love_count");
    const loveMap = new Map((stats || []).map((s: any) => [s.movie_id, s.love_count > 0 ? s.love_sum / s.love_count : 0]));

    const byMode: Record<string, any[]> = {};
    for (const m of movies) {
      const mode = modeOf(m);
      (byMode[mode] ||= []).push(m);
    }
    for (const mode of Object.keys(byMode)) {
      byMode[mode].sort((a, b) => (loveMap.get(b.id) || 0) - (loveMap.get(a.id) || 0));
    }

    // 各媒体から最大2本ずつ、ラウンドロビンで最大7本選ぶ(1媒体に偏らない
    // ようにする、ホーム画面の他の棚で使っているのと同じ考え方)。
    const picked: any[] = [];
    const perModeCount: Record<string, number> = {};
    let more = true;
    while (more && picked.length < 7) {
      more = false;
      for (const mode of MEDIA_MODES) {
        const bucket = byMode[mode];
        if (!bucket) continue;
        const used = perModeCount[mode] || 0;
        if (used >= 2) continue;
        if (used < bucket.length) {
          picked.push(bucket[used]);
          perModeCount[mode] = used + 1;
          more = true;
          if (picked.length >= 7) break;
        }
      }
    }
    if (picked.length < 3) {
      return new Response(JSON.stringify({ error: "not_enough_candidates", tag, count: picked.length }), {
        status: 500,
        headers: jsonHeaders,
      });
    }

    const tool = {
      name: "write_feature",
      description: "選ばれた作品群の実際の中身から、雑誌の特集記事のような紹介文を書く",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "特集のタイトル。雑誌の特集見出しのような、短く惹きつける体言止め(15字程度)。テーマの感情タグ名をそのまま使わない。",
          },
          description: {
            type: "string",
            description:
              "特集の紹介文。120〜160字程度の日本語、改行や段落分けはせず1つの流れる文章にする" +
              "(短く・簡潔に、ホーム画面の小さなカード内に収まる分量)。選ばれた作品群のあらすじ・ジャンルを" +
              "実際に読み比べ、そこから見える共通点を、雑誌の特集前書きのような温かく誘うトーンで一言で書く。" +
              "断定的な決めつけ(「絶対に」等)や良い/悪いの評価は避ける。少なくとも2本のタイトルに触れる。",
          },
        },
        required: ["title", "description"],
      },
    };

    const movieBlocks = picked
      .map((m, i) => {
        const lines = [`${i + 1}. 「${m.title}」`];
        if (m.genre?.length) lines.push(`   ジャンル: ${m.genre.slice(0, 4).join("、")}`);
        if (m.synopsis) lines.push(`   あらすじ: ${String(m.synopsis).slice(0, 250)}`);
        return lines.join("\n");
      })
      .join("\n\n");

    const systemPrompt = [
      "あなたは映画・アニメ・ドラマ・漫画・小説・音楽の発見サイト「Wander」の特集編集者です。",
      `今日のテーマは「${tag}」です。選ばれた作品群の実際のあらすじ・ジャンルを読み比べ、` +
        "雑誌の特集ページの前書きのような紹介文を書いてください。",
      "write_featureツールを必ず1回呼んでください。",
    ].join("\n");

    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: `テーマ: ${tag}\n\n選ばれた作品:\n${movieBlocks}` }],
        tools: [tool],
        tool_choice: { type: "tool", name: "write_feature" },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      return new Response(JSON.stringify({ error: "anthropic_api_error", status: res.status, body }), {
        status: 502,
        headers: jsonHeaders,
      });
    }
    const data = await res.json();
    if (data?.usage) console.log("anthropic_usage", JSON.stringify(data.usage));
    const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "write_feature");
    if (!toolUse) {
      return new Response(JSON.stringify({ error: "no_tool_use_in_response", raw: data }), { status: 502, headers: jsonHeaders });
    }

    const title = String(toolUse.input?.title || "").trim().slice(0, 60);
    const description = String(toolUse.input?.description || "").trim().slice(0, 300);
    if (!title || !description) {
      return new Response(JSON.stringify({ error: "empty_diagnosis_output", raw: toolUse.input }), { status: 502, headers: jsonHeaders });
    }

    const { error: insErr } = await supabase.from("automated_features").insert({
      title,
      description,
      top_tag: tag,
      selected_movie_ids: picked.map((m) => m.id),
    });
    if (insErr) throw insErr;

    return new Response(JSON.stringify({ ok: true, title, tag, movie_ids: picked.map((m) => m.id) }), { headers: jsonHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), { status: 500, headers: corsHeaders });
  }
});

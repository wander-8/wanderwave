import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー要望:「音楽の項目を、今の感情タグ(ワクワク等、全メディア共通の
// 10種)じゃなくて場面ごとにまとめたい。曲の感覚的な部分や実際の歌詞を
// 見ながら当てはまる作品をまとめて欲しい」。
// 歌詞そのものはDBに保存していない(著作権上保存すべきでない)ため、
// 代わりにAI(Claude)自身が持つ曲の知名度・雰囲気の知識で分類する。
// Last.fmの曲タグも補助情報として渡すが、試した結果ジャンルの大分類
// (J-rock/anime等)しか返らず曲の雰囲気そのものはほぼ取れなかったため、
// 主な判断材料ではなく「分かれば使う」程度の補助に留める。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const LASTFM_API_KEY = Deno.env.get("LASTFM_API_KEY") || "";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// index.html側のMUSIC_SCENESと完全に同じ文字列を使う(どちらかだけ変えると
// 「棚のラベル」と「実際に付くタグ」がズレる)。各シーンの直後のコメントは
// オーナーが実際に挙げた意図の補足で、AIへの指示にだけ使い、保存・表示は
// しない。
const MUSIC_SCENES: { name: string; hint: string }[] = [
  { name: "最高級の宝石を身に纏う夜", hint: "美しく強い音楽。豪華で気高い、気持ちが上がるような曲。" },
  { name: "戦闘服を纏って出る時に聞きたい", hint: "戦闘・勝負に向かう高揚感、力強くアグレッシブな曲。" },
  { name: "深夜に足が攣る瞬間", hint: "身体の不条理・シュールさ、ちょっとした不穏さや可笑しさがある曲。" },
  { name: "お風呂に入るのもダルい夜", hint: "脱力・疲労感、何もしたくない気分に寄り添う、気怠い曲。" },
  { name: "休日が楽しみな時の音楽", hint: "高揚感、わくわくする前向きな楽しさがある曲。" },
  { name: "布団でぬくぬく丸まる時間", hint: "安心感、暖かく優しい、守られているような曲。" },
  { name: "世界を旅したい時に聞きたい", hint: "歌詞やタイトルが「旅」をテーマにしているだけのJ-POP/K-POPではなく、民族楽器や現地の歌唱法など、サウンドそのものが伝統音楽・ワールドミュージック的な曲、または特定の国/地域の空気感がサウンドから伝わる曲に限る。" },
  { name: "チルに浸りたい時に聞きたい", hint: "リラックス、ゆったりとした落ち着いた曲。" },
  { name: "時間がないときに聞きたい音楽", hint: "スピード感、テンポが速くせかされるような曲。" },
  { name: "終末に聞きたい", hint: "重厚感と終末感、荘厳で少し絶望的・運命的な曲。" },
  { name: "甘いスイーツを食べる時に聞きたい", hint: "アイドルソングのような可愛らしく甘い曲。" },
  { name: "元気が欲しい時に聞きたい", hint: "明るいだけのJ-POP全般ではなく、意図的に気分を持ち上げたい・前を向きたい時に聞く、励まし・応援ソング的な曲に限る。" },
];
const MUSIC_SCENE_NAMES = MUSIC_SCENES.map((s) => s.name);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Last.fmは補助情報。失敗・該当無しでも分類自体は続行する(必須ではない)。
async function fetchLastfmTags(artist: string, track: string): Promise<string[]> {
  if (!LASTFM_API_KEY || !artist) return [];
  try {
    const url = new URL("https://ws.audioscrobbler.com/2.0/");
    url.searchParams.set("method", "track.gettoptags");
    url.searchParams.set("artist", artist);
    url.searchParams.set("track", track);
    url.searchParams.set("api_key", LASTFM_API_KEY);
    url.searchParams.set("format", "json");
    const res = await fetch(url.toString());
    if (!res.ok) return [];
    const data = await res.json();
    const tags = (data?.toptags?.tag || []).map((t: any) => t?.name).filter(Boolean);
    return tags.slice(0, 5);
  } catch {
    return [];
  }
}

const tool = {
  name: "classify_music_scene",
  description: "曲を、挙げられた「場面」タグの中から当てはまるものだけ選ぶ(0〜2個)",
  input_schema: {
    type: "object",
    properties: {
      scenes: {
        type: "array",
        items: { type: "string", enum: MUSIC_SCENE_NAMES },
        maxItems: 2,
        description:
          "この曲の雰囲気・知られている使われ方(アニメ主題歌なら作品の雰囲気も参考にする)から、" +
          "一覧の中で本当に当てはまるものだけを0〜2個選ぶ。どれにも強く当てはまらない場合は空配列にする" +
          "(無理に当てはめない)。知らない曲・情報が無い曲も空配列でよい。",
      },
    },
    required: ["scenes"],
  },
};

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 30, write = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title, director, genre")
      .eq("is_music", true)
      .is("music_scene_checked_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    const todo = rows || [];

    const results: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const artist = m.director || "";
          const lastfmTags = await fetchLastfmTags(artist, m.title);

          const systemPrompt = [
            "あなたは音楽アプリ「Wander」の選曲担当です。曲名・アーティスト名(分かる場合はジャンル・",
            "参考タグ)から、その曲の雰囲気や知られている使われ方(アニメ主題歌等)をもとに、",
            "以下の「場面」の一覧から当てはまるものだけを選んでください。複数が薄く当てはまりそうな時は、",
            "一番特徴的に・具体的に当てはまる場面を優先してください(「明るい曲だから元気が欲しい時」のような",
            "どの曲にでも言える安易な選び方は避ける)。",
            "",
            MUSIC_SCENES.map((s) => `- 「${s.name}」: ${s.hint}`).join("\n"),
            "",
            "classify_music_sceneツールを必ず1回呼んでください。曲を知らない・判断材料が無い場合や、",
            "どの場面にも強い特徴が無い場合は無理に当てはめず空配列にしてください。",
          ].join("\n");

          const userLines = [`曲名: ${m.title}`];
          if (artist) userLines.push(`アーティスト: ${artist}`);
          if (m.genre?.length) userLines.push(`ジャンル: ${m.genre.join("、")}`);
          if (lastfmTags.length) userLines.push(`参考タグ(Last.fm、ジャンル寄りで曲の雰囲気そのものではないことが多い): ${lastfmTags.join("、")}`);

          const res = await fetch(ANTHROPIC_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
            body: JSON.stringify({
              model: MODEL,
              max_tokens: 200,
              system: systemPrompt,
              messages: [{ role: "user", content: userLines.join("\n") }],
              tools: [tool],
              tool_choice: { type: "tool", name: "classify_music_scene" },
            }),
          });
          if (!res.ok) {
            // 2026-10-16: 原因調査済み(Anthropicのクレジット残高切れ、402/400)。
            // 再発時に再び切り分けられるよう、デバッグ用のstatus/bodyは
            // サーバー側ログにだけ残す(呼び出し元のレスポンスには含めない)。
            console.error(`Anthropic API error for movie ${m.id}: ${res.status} ${await res.text()}`);
            return { movie_id: m.id, title: m.title, transientError: true };
          }
          const data = await res.json();
          const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "classify_music_scene");
          if (!toolUse) {
            console.error(`No tool_use in Anthropic response for movie ${m.id}: ${JSON.stringify(data).slice(0, 300)}`);
            return { movie_id: m.id, title: m.title, transientError: true };
          }
          const scenes: string[] = (toolUse.input?.scenes || []).filter((s: string) => MUSIC_SCENE_NAMES.includes(s));

          if (write) {
            await supabase
              .from("movies")
              .update({
                music_scene_tags: scenes.length ? scenes : null,
                music_scene_checked_at: new Date().toISOString(),
              })
              .eq("id", m.id);
          }
          return { movie_id: m.id, title: m.title, artist, scenes };
        }),
      );
      results.push(...chunkResults);
      await sleep(200);
    }

    return new Response(
      JSON.stringify({
        offset,
        limit,
        write,
        processed: results.length,
        classified: results.filter((r: any) => r.scenes?.length).length,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

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

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
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

// 2026-10-20: オーナー指摘「クレジット使いすぎ」を受けてコスト見直し。
// 以前は曲1件ごとにAnthropic APIを1回呼んでおり、場面一覧+説明文の
// システムプロンプト(500トークン超)を曲の数だけ毎回送り直していたため、
// 残り6,941件だけでも数百万トークン規模の無駄な繰り返しが発生していた。
// 曲をBATCH_SIZE件まとめて1回のAPI呼び出しで判定することで、システム
// プロンプトの送信回数を1/BATCH_SIZEに減らす(出力トークン自体は曲の数に
// 比例するので削れないが、支配的だった繰り返しコストはここで削れる)。
const BATCH_SIZE = 15;
const BATCH_CONCURRENCY = 2;

const tool = {
  name: "classify_music_scenes_batch",
  description: "曲のリストについて、曲ごとに「場面」タグの中から当てはまるものだけ選ぶ(各曲0〜2個)",
  input_schema: {
    type: "object",
    properties: {
      results: {
        type: "array",
        description: "入力した曲の番号(index)ごとの分類結果。入力した曲と同じ件数・同じindexを必ずすべて含めること。",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "入力した曲リストでの番号(0始まり)" },
            scenes: {
              type: "array",
              items: { type: "string", enum: MUSIC_SCENE_NAMES },
              maxItems: 2,
              description: "この曲の雰囲気・知られている使われ方から一覧の中で本当に当てはまるものだけを0〜2個。どれにも強く当てはまらなければ空配列。",
            },
          },
          required: ["index", "scenes"],
        },
      },
    },
    required: ["results"],
  },
};

async function classifyBatch(batch: any[]): Promise<any[]> {
  const lastfmTagsList = await Promise.all(batch.map((m) => fetchLastfmTags(m.director || "", m.title)));

  const systemPrompt = [
    "あなたは音楽アプリ「Wander」の選曲担当です。複数の曲について、曲名・アーティスト名(分かる場合は",
    "ジャンル・参考タグ)から、その曲の雰囲気や知られている使われ方(アニメ主題歌等)をもとに、",
    "以下の「場面」の一覧から当てはまるものだけを選んでください。複数が薄く当てはまりそうな時は、",
    "一番特徴的に・具体的に当てはまる場面を優先してください(「明るい曲だから元気が欲しい時」のような",
    "どの曲にでも言える安易な選び方は避ける)。同じジャンルやアーティストの曲が複数並んでいても、",
    "それぞれ独立に判断してください。前の曲と同じジャンルだから・似た並びだからという理由だけで",
    "同じ分類を機械的に繰り返さないこと。知らない曲は(ジャンルだけ分かっていても)空配列にしてください。",
    "",
    MUSIC_SCENES.map((s) => `- 「${s.name}」: ${s.hint}`).join("\n"),
    "",
    "classify_music_scenes_batchツールを必ず1回呼んでください。resultsには入力した曲と同じ件数・",
    "同じindexをすべて含めてください。曲を知らない・判断材料が無い場合や、どの場面にも強い特徴が無い",
    "場合は無理に当てはめず空配列にしてください。",
  ].join("\n");

  const userLines = batch
    .map((m, idx) => {
      const parts = [`${idx}. 曲名: ${m.title}`];
      if (m.director) parts.push(`アーティスト: ${m.director}`);
      if (m.genre?.length) parts.push(`ジャンル: ${m.genre.join("、")}`);
      const tags = lastfmTagsList[idx];
      if (tags.length) parts.push(`参考タグ(Last.fm、ジャンル寄りで曲の雰囲気そのものではないことが多い): ${tags.join("、")}`);
      return parts.join(" / ");
    })
    .join("\n");

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: userLines }],
      tools: [tool],
      tool_choice: { type: "tool", name: "classify_music_scenes_batch" },
    }),
  });
  if (!res.ok) {
    // 2026-10-16: 原因調査済み(Anthropicのクレジット残高切れ、402/400)。
    // 再発時に再び切り分けられるよう、デバッグ用のstatus/bodyは
    // サーバー側ログにだけ残す(呼び出し元のレスポンスには含めない)。
    console.error(`Anthropic API error for batch starting at movie ${batch[0]?.id}: ${res.status} ${await res.text()}`);
    return batch.map((m) => ({ movie_id: m.id, title: m.title, transientError: true }));
  }
  const data = await res.json();
  const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "classify_music_scenes_batch");
  if (!toolUse) {
    console.error(`No tool_use in Anthropic response for batch starting at movie ${batch[0]?.id}: ${JSON.stringify(data).slice(0, 300)}`);
    return batch.map((m) => ({ movie_id: m.id, title: m.title, transientError: true }));
  }

  const byIndex = new Map<number, string[]>();
  for (const r of toolUse.input?.results || []) {
    if (typeof r?.index === "number") {
      byIndex.set(r.index, (r.scenes || []).filter((s: string) => MUSIC_SCENE_NAMES.includes(s)));
    }
  }

  const out: any[] = [];
  for (let idx = 0; idx < batch.length; idx++) {
    const m = batch[idx];
    const got = byIndex.has(idx);
    const scenes = byIndex.get(idx) || [];
    // モデルが一部のindexを返し忘れた場合は、その曲だけ未分類のまま次回に
    // 回す(music_scene_checked_atを更新しない)。transientErrorとして
    // 扱えば呼び出し元のdoneループでも誤って「完了」扱いされない。
    if (!got) {
      out.push({ movie_id: m.id, title: m.title, transientError: true });
      continue;
    }
    out.push({ movie_id: m.id, title: m.title, scenes });
  }
  return out;
}

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
    // 取得元はDBの取り込み順(=id順)でまとまって同じジャンル・同じ
    // アーティストが連続しがちで(確認済み:同じレゲエのアーティストが
    // 連続16件)、そのままバッチ化すると「同じジャンルが並んでいる」こと
    // 自体をAIが手がかりにしてしまい、本来は空配列にすべき無名の曲にまで
    // 前の曲と同じタグを機械的にコピーしてしまう事故が実際に起きた(試験
    // 投入で16件中16件が同一タグになった)。1回のAPI呼び出しに渡す前に
    // シャッフルして同じジャンルの並びを崩す。
    const todo = shuffle(rows || []);

    const batches: any[][] = [];
    for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

    const results: any[] = [];
    for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
      const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
      const chunkResults = await Promise.all(chunk.map((b) => classifyBatch(b)));
      for (const r of chunkResults) results.push(...r);
      await sleep(200);
    }

    if (write) {
      const toWrite = results.filter((r: any) => !r.transientError);
      for (const r of toWrite) {
        await supabase
          .from("movies")
          .update({
            music_scene_tags: r.scenes?.length ? r.scenes : null,
            music_scene_checked_at: new Date().toISOString(),
          })
          .eq("id", r.movie_id);
      }
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

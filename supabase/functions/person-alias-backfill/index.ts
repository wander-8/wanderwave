import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// 「マイケル・ジャクソン(映画側はカタカナ表記)」と「Michael Jackson(音楽側は
// iTunesのローマ字のまま)」のように、同一人物でも映画/ドラマ/アニメ側
// (TMDbのja-JP名)と音楽側(iTunesのアーティスト名、ほぼ英語のまま)で
// 表記が別の文字体系になっており、人物名クリックでのクロスメディア検索が
// 実質つながっていなかった(オーナー指摘: 星野源は繋がるのにマイケル・
// ジャクソンだと映画しか出ない=両方同じに見えた)。
//
// 日本語の名前同士は両パイプラインとも同じ表記になるため問題にならない。
// 問題になるのは「音楽側が英語表記のままの、西洋のアーティスト」だけなので、
// その集合だけを対象に、Claudeに「このアーティストの一般的なカタカナ表記」を
// 挙げてもらい、実際に映画/ドラマ/アニメ側の人物名データの中にその
// カタカナ表記が存在するかを突き合わせて確認が取れた場合だけ
// person_aliasesテーブルに別名ペアとして保存する(Claudeの出力をそのまま
// 信用せず、既存の実データと一致した時だけ採用することで誤った名寄せを防ぐ)。

async function fetchAllMusicDirectors(supabase: any): Promise<string[]> {
  // PostgRESTはデフォルトで1行取得あたり1000件に制限されるため、
  // .range()無しの単発selectだと音楽作品が1000件を超える時点で
  // 取りこぼしが発生する(idで安定ソートしてページングする)。
  const PAGE_SIZE = 1000;
  const all: string[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("movies")
      .select("director")
      .eq("is_music", true)
      .not("director", "is", null)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all.push(...(data || []).map((r: any) => r.director as string));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchNonMusicNameSet(supabase: any): Promise<Set<string>> {
  // 全件(10万件規模)だと保持コストが大きいため、カタカナ人名パターン
  // (西洋人名の日本語表記特有の「カタカナ・カタカナ」中点区切りを含む)に
  // 絞り込んだ上でPostgres側でdistinctを取る。日本人名同士の名寄せは
  // 元々表記が揃っているため対象外でよい。
  // PostgRESTのRPC(SETOF戻り値)もテーブルselectと同じく1000件上限が
  // 掛かるため(マイケル・ジャクソンが1000件目より後ろに来て取得漏れし、
  // 一致確認できていなかった実例あり)、.range()で明示的にページングする。
  const PAGE_SIZE = 1000;
  const all = new Set<string>();
  let from = 0;
  while (true) {
    const { data, error } = await supabase.rpc("person_alias_candidate_names").range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    (data || []).forEach((r: any) => all.add(r.name as string));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function callClaudeTransliterate(names: string[]): Promise<Record<string, string>> {
  const tool = {
    name: "transliterate",
    description: "各アーティスト名について、日本語メディアで一般的に使われるカタカナ表記を答える。",
    input_schema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              katakana: {
                type: "string",
                description: "実在する個人で、広く定着したカタカナ表記が確実にある場合のみそれを入れる。バンド/グループ名や、確信が持てない場合、複数人からなる名義の場合は空文字列。",
              },
            },
            required: ["name", "katakana"],
          },
        },
      },
      required: ["results"],
    },
  };
  const systemPrompt = [
    "あなたは音楽アーティスト名の日本語表記に詳しいアシスタントです。",
    "与えられた各アーティスト名について、日本語メディア(Wikipedia日本語版、CDショップ等)で",
    "広く使われている標準的なカタカナ表記を transliterate ツールで答えてください。",
    "",
    "重要なルール:",
    "- 確信が持てる場合だけ埋める。あやふやな推測や自己流のローマ字読みは絶対にしない。",
    "- バンド・グループ名(例: Coldplay, BTS)は空文字列のままでよい(個人名の時だけ埋める)。",
    "- 全員分、順番通りに results 配列へ入れる(省略しない)。",
  ].join("\n");

  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: names.join("\n") }],
      tools: [tool],
      tool_choice: { type: "tool", name: "transliterate" },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`anthropic_api_error ${res.status}: ${body}`);
  }
  const data = await res.json();
  const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "transliterate");
  if (!toolUse) throw new Error("no_tool_use_in_response");
  const results = toolUse.input?.results || [];
  const map: Record<string, string> = {};
  for (const r of results) {
    if (r && typeof r.name === "string" && typeof r.katakana === "string" && r.katakana.trim()) {
      map[r.name] = r.katakana.trim();
    }
  }
  return map;
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, offset = 0, limit = 30 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 音楽側の候補(西洋表記のまま=カタカナ・漢字・ひらがなを含まない名前)。
    // PostgRESTの.likeは正規表現非対応なので、全件取得してJS側で絞り込み、
    // アルファベット順で安定ソートしてoffset/limitでバッチ処理する
    // (日本語名は元々表記が揃っているため対象外)。
    const allMusicDirectors = await fetchAllMusicDirectors(supabase);

    const jpCharPattern = /[ぁ-んァ-ヶ一-龠]/;
    const distinctArtists = Array.from(
      new Set(
        allMusicDirectors
          .map((d) => (d || "").trim())
          .filter((n: string) => n && !jpCharPattern.test(n)),
      ),
    ).sort();

    const batch = distinctArtists.slice(offset, offset + limit);
    if (batch.length === 0) {
      return new Response(
        JSON.stringify({ dry_run, offset, next_offset: offset, total: distinctArtists.length, done: true, matched: [] }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const nonMusicNames = await fetchNonMusicNameSet(supabase);

    const guesses = await callClaudeTransliterate(batch);
    const matched: { name: string; katakana: string }[] = [];
    for (const [name, katakana] of Object.entries(guesses)) {
      if (nonMusicNames.has(katakana)) {
        matched.push({ name, katakana });
      }
    }

    if (!dry_run && matched.length) {
      const rows = matched.flatMap((m) => [
        { name_a: m.name, name_b: m.katakana },
        { name_a: m.katakana, name_b: m.name },
      ]);
      const { error: insErr } = await supabase
        .from("person_aliases")
        .upsert(rows, { onConflict: "name_a,name_b", ignoreDuplicates: true });
      if (insErr) throw insErr;
    }

    return new Response(
      JSON.stringify({
        dry_run,
        offset,
        next_offset: offset + batch.length,
        total: distinctArtists.length,
        batch_size: batch.length,
        done: offset + batch.length >= distinctArtists.length,
        matched,
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

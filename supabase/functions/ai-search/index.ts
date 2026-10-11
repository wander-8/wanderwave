import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// ブラウザから直接叩くため、他のクライアント向け関数(submit-contact等)と
// 同じCORSヘッダーが無いとOPTIONSプリフライトで弾かれる。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 「AI検索」: ユーザーが自由文(例:「雨の日に見たい泣ける映画」)を入力すると、
// 作品の実際の中身(タイトル・あらすじ・ジャンル・出演者・監督/アーティスト・
// 制作国・感情タグ)に結び付きそうな短い言葉を拾い、フロント側の通常の
// 部分一致検索(queryKeywords、termMatchesMovie参照)にそのまま渡す。
//
// 以前は感情タグ・ジャンル・国を、フロント側が渡したenum語彙の中から選ばせ、
// 既存の絞り込みチップ(activeTags/activeGenres/activeCountries)に変換して
// いた。しかしこの「カテゴリを1つ選んで絞り込む」という操作そのものが、
// 曖昧・感覚的な文章で検索したい時の体験と合わなかった(オーナー指摘:
// 「感覚で検索した時に、いつも絞り込みされるんだけどそうじゃなくて、
// Googleとか一般的な検索サイトで見たときに使うような記事の内容とかから
// イメージさせてほしい」「検索の絞り込み機能やめてほしい。もっと感覚で
// 視覚的聴覚的にみんながイメージするものを取り入れたい。これは全部の項目の
// 検索機能に投じてほしい」)。手動でチップを押す「詳しく絞り込む」自体は
// 従来通り残すが、AI検索はチップへの変換をやめ、実際の中身への部分一致
// 検索(searchTerms)だけに統一する。media種別を問わず同じ挙動にする。
//
// tool_choiceで強制的にツールを呼ばせる(自由回答の文章ではなく、必ず
// 構造化された配列が返る形にするため。中身は自由記述なので、以前のような
// enum制約(存在しない値のでっち上げ防止)はもう無い)。

type RequestBody = {
  query?: string;
  decades?: number[];
  mode?: string;
  genres?: string[];
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };
  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on this project" }),
        { status: 500, headers: jsonHeaders },
      );
    }

    const body: RequestBody = await req.json().catch(() => ({}));
    const query = (body.query || "").trim();
    const decades = Array.isArray(body.decades) ? body.decades.filter((d) => typeof d === "number") : [];
    const mode = typeof body.mode === "string" ? body.mode : "";
    const genres = Array.isArray(body.genres) ? body.genres.filter((g) => typeof g === "string") : [];

    if (!query) {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const decadeProperty: Record<string, unknown> = decades.length
      ? { type: "integer", enum: decades, description: "最も近い年代。「80年代の」のように明確な言及がある時だけ入れる。該当が無ければこのフィールド自体を省略する。" }
      : { type: "integer", description: "年代の指定が無いので使わない(省略する)。" };

    const tool = {
      name: "extract_search_terms",
      description: "ユーザーの自由文から、作品の実際の中身に結び付きそうな短い言葉を抜き出す。",
      input_schema: {
        type: "object",
        properties: {
          searchTerms: {
            type: "array",
            items: { type: "string" },
            description: "文章が思い起こさせる、短い単語・フレーズを基本1〜2個(多くても4個)。" +
              "タイトル・あらすじ・ジャンル・出演者/監督・アーティスト名・制作国・感情タグの" +
              "どこかに部分一致しそうな言葉を入れる(各要素は独立に判定されるAND条件。" +
              "例:「猫を飼っている双子が出てくる怖い映画」→[\"双子\",\"猫\",\"怖い\"])。" +
              "具体的な見た目・設定・物の名前だけでなく、感情タグ(「楽しい」「感動」" +
              "「リラックス」「ワクワク」「怖い」「美しい」「ドキドキ」「笑い」「悲しい」" +
              "「考えさせられる」)・雰囲気や見た目/音の印象を表す言葉も積極的に含めてよい。" +
              "ジャンル名(「ホラー」「K-Pop」等)は、文章が具体的な物・設定より先にジャンル" +
              "そのものを前面に出している時だけ使う(既に具体的な物の名前がある時に追加で" +
              "足すと、ジャンル欄が無い/一致しない作品で0件になりやすい)。各要素は単語単位" +
              "(文章全体や長い説明文はそのまま入れない。部分一致なので短いほど当たりやすい)。" +
              "本当に何も思い当たらない曖昧な文章(例:「何か面白いの無い?」)の時だけ空配列にする。",
          },
          decade: decadeProperty,
        },
        required: ["searchTerms"],
      },
    };

    const systemPrompt = [
      "あなたは映画・アニメ・ドラマ・漫画・小説・音楽の発見サイト「Wander」の検索アシスタントです。",
      "ユーザーが入力した自由な文章から、作品の実際の中身(タイトル・あらすじ・ジャンル・出演者・",
      "監督/アーティスト・制作国・感情タグ)に結び付きそうな短い言葉を抜き出し、",
      "extract_search_termsツールを呼んでください。",
      "",
      "重要なルール:",
      "- ここで拾った言葉は、検索欄にそのまま打ち込んだのと同じように、作品の中身への",
      "  部分一致検索に使われる(Googleのような一般的な検索サイトの感覚に近い)。",
      "  決まった選択肢から1つ選んでカテゴリ分けする作業ではない。",
      "- 複数の言葉を拾った時は全部が同時に満たされる(AND)条件になるので、入れすぎると",
      "  0件になりやすい。基本は1〜2個に絞り、3個以上は本当に別々の要素(物・設定・",
      "  ジャンル等)が文章に複数ある時だけにする。",
      "- 同じ意味・ニュアンスの言い換えを複数同時に入れないこと(例:「感動」で十分なのに",
      "  「泣ける」も一緒に入れる、「ジャズ」で十分なのに「ブルース」も一緒に入れる、",
      "  「Alternative」で十分なのに「エモい」も一緒に入れる、等)。「エモい」「尊い」",
      "  「刺さる」のような、下記のジャンル一覧にも感情タグ一覧にも無い口語的な",
      "  言い換えは、対応するジャンル名・感情タグに変換できた時点でそれ自体は使わない",
      "  (口語のスラングそのままでは作品の中身に一致しないため、足しても0件になるだけ)。",
      "  似た言葉が思い浮かんでも、最も作品の実際のジャンル名・感情タグに近い1語だけを選ぶ",
      "  (下記の語彙一覧にある表記が使えるなら、それを優先する)。類義語を並べるとAND条件が",
      "  無駄に厳しくなり0件になりやすい。",
      "- 具体的な見た目・設定・物の名前(「赤いドレス」「双子」「猫」「転生」等)はもちろん、",
      "  感情タグ・雰囲気/視覚的/聴覚的な印象を表す言葉も、同じようにsearchTermsに",
      "  入れてよい(例:「海外ギャルっぽい曲」→[\"K-Pop\"]、「雨の日に見たい泣ける映画」→",
      "  [\"感動\"]、「渋い感じの洋楽」→[\"Jazz\"]、「猫を飼っている双子が出てくる怖い映画」→",
      "  [\"双子\",\"猫\",\"怖い\"])。それぞれの言葉が実際にタイトル・あらすじ・ジャンル・",
      "  感情タグのどこかに現れそうか、という手がかりとして考える。",
      "- ジャンル名は、下記のジャンル一覧にある表記(大文字小文字・英語表記含む)のまま",
      "  使うこと。ただし文章に具体的な物・設定の名前が既にある時は、ジャンル名を追加で",
      "  足さない方が安全(ジャンル欄は全作品に正確に付いているとは限らず、AND条件に",
      "  加えるとその作品がたまたまそのジャンルを持っていない場合に0件になる。実例:",
      "  「赤いドレスの怖い映画」は[\"赤いドレス\"]のみで十分で、\"ホラー\"まで足すと",
      "  実際にヒットすべき唯一の作品がジャンル欄に\"ホラー\"を持っておらず0件になっていた)。",
      "  文章が具体的な物・設定より先にジャンルそのものを前面に出している時(例:",
      "  「K-Popっぽい曲」「ホラー映画が見たい」)だけ、ジャンル名を使う。",
      "- 「雨の日に見たい」「寝る前に」のような状況・シーン描写だけで、特定の感情や",
      "  ジャンルを1つに決め打ちしないこと(「雨の日」からリラックスしたいのか、しっとり",
      "  悲しい気分なのかは決まらない)。文章にもっと具体的な手がかり(「泣ける」「ワクワクする」",
      "  「K-Pop系」等)が別途あれば、それを拾う。",
      "- 文章から確信を持って読み取れないものは、無理に埋めない。本当に何も手がかりが無い",
      "  曖昧な文章(例:「何か面白いの無い?」)では、searchTermsを空配列にしてよい。",
      "- 「かっこいい」「おしゃれ」「ダサい」のような、作品の感想・見た目の印象を表す",
      "  形容詞は、その言葉自体がタイトル・あらすじ等に書かれていることはまず無いので、",
      "  そのままsearchTermsに入れても一致しない。そのニュアンスに近いジャンル・感情タグ",
      "  (例:「かっこいい」→ドキドキ、アクション系のジャンル)があれば変換して使い、",
      "  近いものが思い付かなければ、その言葉自体は諦めて空配列(または他の手がかりだけ)",
      "  にする方がよい(無理に文字通り検索しても0件になるだけで、スラングを足している",
      "  のと同じ失敗になる)。",
      "- 年代は「80年代の」「最近の」のように時代への言及が明確な時だけdecadeに入れる。",
      "",
      `選べる年代: ${decades.map((d) => `${d}年代`).join("、") || "(なし)"}`,
      `ジャンルの表記一覧(ジャンルを表す言葉を入れる時はこの中の表記に合わせる。無ければ自由に単語を選んでよい): ${genres.join("、") || "(なし)"}`,
      // 音楽モードだけの補足。映画・アニメ等と違って音楽作品には実際の
      // あらすじ・ストーリー要素が存在しない(synopsisは「収録曲数: N曲」
      // という表示用の文字列でしかない)ため、タイトル・ジャンル・アーティスト名・
      // 感情タグが頼りになる。雰囲気語からジャンル・感情タグを積極的に
      // 推測しないと、音楽だけ毎回0件になりやすい(オーナー指摘:「海外
      // ギャルっぽいとか適当に打ってもいいようにしたい」)。
      ...(mode === "music"
        ? [
          "",
          "音楽モードの補足: 音楽作品にはあらすじ・ストーリー要素が無く、タイトル・",
          "ジャンル・アーティスト名・感情タグだけが手がかり。そのため「どんな場面・",
          "シチュエーションで聴きたいか」を表す言葉(例:「ギャル系」「渋谷系」",
          "「パリピ」「エモい」「クラブで流れてそう」はもちろん、「海辺で聴きたい」",
          "「ドライブで聴きたい」「カフェで流れてそう」「勉強中に聴きたい」のような",
          "場所・シーン描写も含む)は、その場所・シーンの言葉自体をsearchTermsに",
          "入れても音楽作品の中身には絶対に一致しない(「海辺」という文字が入っている",
          "曲は無い)。必ず、その場面に合いそうなジャンル名(上のジャンル表記一覧から。",
          "例:海辺→Reggae/Latin/World、ドライブ→Rock/Pop、カフェ→Jazz/Acoustic寄りの",
          "ジャンル、勉強中→Classical/Ambient/New Age)や感情タグに変換してから",
          "searchTermsに入れること。場面の言葉をそのまま使うのは禁止。基本1〜2個に",
          "絞るルールは音楽モードでも変わらない。",
        ]
        : []),
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
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: query }],
        tools: [tool],
        tool_choice: { type: "tool", name: "extract_search_terms" },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return new Response(JSON.stringify({ error: "anthropic_api_error", status: res.status, body: errBody }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const data = await res.json();
    const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "extract_search_terms");
    if (!toolUse) {
      return new Response(JSON.stringify({ error: "no_tool_use_in_response", raw: data }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const input = toolUse.input || {};
    const resultDecade = typeof input.decade === "number" && decades.includes(input.decade) ? input.decade : null;
    const resultSearchKeywords = (Array.isArray(input.searchTerms) ? input.searchTerms : [])
      .filter((k: unknown): k is string => typeof k === "string")
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 0)
      .slice(0, 4)
      .map((k: string) => k.slice(0, 40));

    return new Response(
      JSON.stringify({
        decade: resultDecade,
        searchKeywords: resultSearchKeywords,
      }),
      { headers: jsonHeaders },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});

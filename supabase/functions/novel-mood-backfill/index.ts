import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// rakuten-discover-novelにinferMoodTagsを追加した後、既存の小説行
// (GENRE_PREFIX_MAP経由、絵本等のdirectBookTypeとは別)を今のロジックで
// 作り直す。既存行は例えば「ドラマ」6566件が全件[感動,考えさせられる]
// 固定だった(オーナー指摘: 感情タグを複数組み合わせると何も出てこない)。
// title/synopsisは既にDBに保存済みなので、book-mood-country-backfillと
// 同じく楽天APIへの再検索は不要。

const MOOD_KEYWORDS: Record<string, string[]> = {
  "ワクワク": [
    "しかけ", "とびだす", "ぼうけん", "冒険", "たんけん", "探検", "きょうりゅう", "恐竜",
    "うちゅう", "宇宙", "ロケット", "のりもの", "でんしゃ", "電車", "しょうぼうしゃ", "救急車",
    "へんしん", "変身", "たからもの", "宝物", "たからじま", "まほう", "魔法", "忍者", "にんじゃ",
    "怪盗", "ヒーロー", "どうぶつ", "動物", "こんちゅう", "昆虫",
    "異世界", "転生", "転移", "魔王", "勇者", "冒険者", "ダンジョン", "バトル", "戦闘", "魔物",
  ],
  "感動": [
    "感動", "涙", "泣ける", "ほろり", "じんわり", "心温まる", "家族の絆", "ありがとう",
    "いのちの大切さ", "命の大切さ", "再会", "旅立ち", "親子の愛",
    "恋", "両想い", "プロポーズ", "青春", "友情", "絆",
  ],
  "リラックス": [
    "おやすみ", "ねむる", "ねんね", "眠り", "子守", "こもりうた", "寝かしつけ", "まったり",
    "ほっこり", "スキンシップ", "あかちゃん", "赤ちゃん", "語りかけ",
  ],
  "怖い": [
    "おばけ", "ゆうれい", "幽霊", "ようかい", "妖怪", "おに", "鬼", "やみ", "闇",
    "のろい", "呪い", "ホラー", "魔女", "こわい話", "怖い話",
    "猟奇", "惨劇", "恐怖",
  ],
  "美しい": [
    "うつくしい", "美しい", "きれい", "綺麗", "花", "はな", "自然", "しぜん", "四季",
    "季節", "星空", "海の", "虹", "名画", "絵画", "しょくぶつ", "植物",
  ],
  "ドキドキ": [
    "どきどき", "ハラハラ", "スリル", "追いかけ", "対決", "勝負", "レース", "競争", "サスペンス",
    "謎", "事件", "殺人", "犯人", "密室", "トリック", "誘拐", "失踪",
  ],
  "笑い": [
    "おもしろい", "面白い", "ギャグ", "コメディ", "ユーモア", "へんてこ", "どたばた",
    "わらえる", "笑える", "げらげら", "くすっと",
  ],
  "悲しい": ["さびしい", "寂しい", "悲しい", "かなしい", "なみだ", "別れ", "さよなら", "いなくなっ"],
  "考えさせられる": [
    "いのち", "命", "せんそう", "戦争", "へいわ", "平和", "しゃかい", "社会", "かんきょう",
    "環境", "人権", "じんせい", "人生", "せかい", "世界の", "差別", "貧困", "災害", "震災",
    "復讐", "裏切り", "運命", "正義", "罪",
  ],
  "楽しい": [
    "たのしい", "楽しい", "あそぶ", "遊ぶ", "ゆかい", "愉快", "うた", "歌", "おどる", "踊る",
    "パーティー", "えがお", "笑顔",
  ],
};
function inferMoodTags(title: string, caption: string | null | undefined, fallback: string[]): string[] {
  const text = `${title} ${caption || ""}`;
  const scores: [string, number][] = [];
  for (const [tag, words] of Object.entries(MOOD_KEYWORDS)) {
    const hits = words.filter((w) => text.includes(w)).length;
    if (hits > 0) scores.push([tag, hits]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const ranked = scores.map(([tag]) => tag);
  if (ranked.length === 0) return fallback;
  const result = ranked.slice(0, 2);
  for (const t of fallback) {
    if (result.length >= 2) break;
    if (!result.includes(t)) result.push(t);
  }
  return result;
}

// rakuten-discover-novelのGENRE_PREFIX_MAPと同じ対応(genre配列の完全一致で
// 判定する。「恋愛」単独(ロマンス)と「恋愛・ファンタジー」(ライトノベル)で
// 既定タグが違うため、先頭要素だけでなく配列全体を見る必要がある)。
const NOVEL_FALLBACK: [string[], string[]][] = [
  [["ミステリー"], ["考えさせられる", "ドキドキ"]],
  [["SF", "ホラー"], ["怖い", "考えさせられる"]],
  [["ドラマ"], ["感動", "考えさせられる"]],
  [["恋愛"], ["感動", "美しい"]],
  [["アクション", "ファンタジー"], ["ワクワク", "ドキドキ"]],
  [["恋愛", "ファンタジー"], ["ドキドキ", "感動"]],
];
function fallbackFor(genre: string[] | null): string[] | null {
  if (genre === null) return ["楽しい"]; // DEFAULT_GENRE(その他の小説)
  for (const [g, tags] of NOVEL_FALLBACK) {
    if (g.length === genre.length && g.every((v, i) => v === genre[i])) return tags;
  }
  return null; // 絵本等のdirectBookType行、または未知の組み合わせ(対象外)
}

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 300 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error: rowsErr } = await supabase
      .from("movies")
      .select("id, title, genre, synopsis, emotion_tags")
      .eq("is_novel", true)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (rowsErr) throw rowsErr;

    const { count: totalRemaining } = await supabase
      .from("movies")
      .select("id", { count: "exact", head: true })
      .eq("is_novel", true)
      .gt("id", after_id);

    const results: any[] = [];
    for (const row of rows || []) {
      const fallback = fallbackFor(row.genre);
      if (!fallback) continue; // 本の種類(絵本等)はこの関数の対象外、既存のbook-mood-country-backfillで対応済み
      const newTags = inferMoodTags(row.title, row.synopsis, fallback);
      const changed = JSON.stringify(newTags) !== JSON.stringify(row.emotion_tags);
      if (changed) {
        results.push({ id: row.id, title: row.title, genre: row.genre, before: row.emotion_tags, after: newTags, changed: true });
        if (!dry_run) {
          const { error: upErr } = await supabase.from("movies").update({ emotion_tags: newTags }).eq("id", row.id);
          if (upErr) throw upErr;
        }
      }
    }

    const nextAfterId = rows && rows.length ? rows[rows.length - 1].id : after_id;

    return new Response(
      JSON.stringify({
        dry_run,
        total_remaining_before_this_batch: totalRemaining,
        after_id,
        next_after_id: nextAfterId,
        batch_size: (rows || []).length,
        done: (rows || []).length < limit,
        changed_count: results.filter((r) => r.changed).length,
        results: dry_run ? results : undefined,
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

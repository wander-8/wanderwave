import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// rakuten-discover-novelにinferMoodTags/isForeignAuthorNameを追加した後、
// 既存行(絵本・図鑑・児童書・児童文庫・民話は感情タグが本の種類ごとに
// 固定2個、ほぼ全ジャンルの本が著者名ベースの国別判定が無かった)を
// 今のロジックで作り直す。title・synopsis・directorは既にDBに保存済みの
// ため、rakuten-book-reclassifyと違い楽天APIへの再検索は不要(DBの読み書き
// だけで完結する)。

const MOOD_KEYWORDS: Record<string, string[]> = {
  "ワクワク": [
    "しかけ", "とびだす", "ぼうけん", "冒険", "たんけん", "探検", "きょうりゅう", "恐竜",
    "うちゅう", "宇宙", "ロケット", "のりもの", "でんしゃ", "電車", "しょうぼうしゃ", "救急車",
    "へんしん", "変身", "たからもの", "宝物", "たからじま", "まほう", "魔法", "忍者", "にんじゃ",
    "怪盗", "ヒーロー", "どうぶつ", "動物", "こんちゅう", "昆虫",
  ],
  "感動": [
    "感動", "涙", "泣ける", "ほろり", "じんわり", "心温まる", "家族の絆", "ありがとう",
    "いのちの大切さ", "命の大切さ", "再会", "旅立ち", "親子の愛",
  ],
  "リラックス": [
    "おやすみ", "ねむる", "ねんね", "眠り", "子守", "こもりうた", "寝かしつけ", "まったり",
    "ほっこり", "スキンシップ", "あかちゃん", "赤ちゃん", "語りかけ",
  ],
  "怖い": [
    "おばけ", "ゆうれい", "幽霊", "ようかい", "妖怪", "おに", "鬼", "やみ", "闇",
    "のろい", "呪い", "ホラー", "魔女", "こわい話", "怖い話",
  ],
  "美しい": [
    "うつくしい", "美しい", "きれい", "綺麗", "花", "はな", "自然", "しぜん", "四季",
    "季節", "星空", "海の", "虹", "名画", "絵画", "しょくぶつ", "植物",
  ],
  "ドキドキ": ["どきどき", "ハラハラ", "スリル", "追いかけ", "対決", "勝負", "レース", "競争", "サスペンス"],
  "笑い": [
    "おもしろい", "面白い", "ギャグ", "コメディ", "ユーモア", "へんてこ", "どたばた",
    "わらえる", "笑える", "げらげら", "くすっと",
  ],
  "悲しい": ["さびしい", "寂しい", "悲しい", "かなしい", "なみだ", "別れ", "さよなら", "いなくなっ"],
  "考えさせられる": [
    "いのち", "命", "せんそう", "戦争", "へいわ", "平和", "しゃかい", "社会", "かんきょう",
    "環境", "人権", "じんせい", "人生", "せかい", "世界の", "差別", "貧困", "災害", "震災",
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

function isForeignAuthorName(author: string | null | undefined): boolean {
  if (!author) return false;
  return author.split("/").some((seg) => /[ァ-ヴー]{2,}・[ァ-ヴー]{2,}/.test(seg.trim()));
}

// directBookType.tags(rakuten-discover-novel)と同じ値。感情タグ推定が
// 当たらなかった場合のフォールバックに使う。
const MOOD_FALLBACK: Record<string, string[]> = {
  "絵本": ["楽しい", "美しい"],
  "図鑑": ["考えさせられる", "美しい"],
  "児童書": ["楽しい", "考えさせられる"],
  "児童文庫": ["楽しい", "ワクワク"],
  "民話・むかし話": ["考えさせられる", "美しい"],
  "写真": ["美しい", "リラックス"],
};
const MOOD_INFER_GENRES = new Set(Object.keys(MOOD_FALLBACK));

const BOOK_GENRES = [
  "絵本", "図鑑", "新書", "児童書", "児童文庫", "民話・むかし話", "美術", "写真",
  "日本美術", "東洋美術", "西洋美術", "デザイン", "イラスト", "美術館",
  "小説・エッセイ", "暮らし・健康・料理", "語学・学習参考書", "旅行・留学・アウトドア",
  "人文・思想・社会", "ビジネス・経済・就職", "パソコン・システム開発", "科学・医学・技術", "エンタメ",
];

Deno.serve(async (req: Request) => {
  try {
    const { dry_run = true, after_id = 0, limit = 200 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error: rowsErr } = await supabase
      .from("movies")
      .select("id, title, genre, country, director, synopsis, emotion_tags")
      .eq("is_novel", true)
      .overlaps("genre", BOOK_GENRES)
      .gt("id", after_id)
      .order("id", { ascending: true })
      .limit(limit);
    if (rowsErr) throw rowsErr;

    const { count: totalRemaining } = await supabase
      .from("movies")
      .select("id", { count: "exact", head: true })
      .eq("is_novel", true)
      .overlaps("genre", BOOK_GENRES)
      .gt("id", after_id);

    const results: any[] = [];
    for (const row of rows || []) {
      const primaryGenre = (row.genre || [])[0] || "";
      const newCountry = (row.country === "海外" || isForeignAuthorName(row.director)) ? "海外" : row.country;
      const newTags = MOOD_INFER_GENRES.has(primaryGenre)
        ? inferMoodTags(row.title, row.synopsis, MOOD_FALLBACK[primaryGenre])
        : row.emotion_tags;

      const countryChanged = newCountry !== row.country;
      const tagsChanged = JSON.stringify(newTags) !== JSON.stringify(row.emotion_tags);
      if (countryChanged || tagsChanged) {
        results.push({
          id: row.id, title: row.title,
          country_before: row.country, country_after: newCountry,
          tags_before: row.emotion_tags, tags_after: newTags,
          changed: true,
        });
        if (!dry_run) {
          const update: Record<string, unknown> = {};
          if (countryChanged) update.country = newCountry;
          if (tagsChanged) update.emotion_tags = newTags;
          const { error: upErr } = await supabase.from("movies").update(update).eq("id", row.id);
          if (upErr) throw upErr;
        }
      } else {
        results.push({ id: row.id, title: row.title, changed: false });
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

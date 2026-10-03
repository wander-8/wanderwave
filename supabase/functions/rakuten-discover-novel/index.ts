import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAKUTEN_APP_ID = Deno.env.get("RAKUTEN_APP_ID")!;
const RAKUTEN_ACCESS_KEY = Deno.env.get("RAKUTEN_ACCESS_KEY")!;
const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
const SITE_URL = "https://wander-8.site/";

// rakuten-discover-mangaと同じ楽天ブックス書籍検索APIを使い、小説を取り込む。
// booksGenreId="001004"(小説・エッセイ)と"001017"(ライトノベル)の2カテゴリを
// 対象にする(呼び出し側でbooks_genre_idを切り替えて2回叩く想定)。
// 1商品が複数のジャンル階層(文庫/絵本/小説等)に同時に属することが多く、
// 物語作品かどうかの判定は先頭のジャンルIDだけでは不十分(例:
// エッセイ集が"001020014/001004003001"のように新書側が先頭に来る)。
// そのため、"/"区切りの全セグメントを見て、ここに列挙した「小説の
// サブジャンル」に1つでも当てはまれば小説候補として扱う(ホワイトリスト方式)。
// 当てはまらない場合はエッセイ・ノンフィクション・実用書等とみなして除外する。
const GENRE_PREFIX_MAP: Record<string, { ja: string[] | null; tags: string[]; baseTier: number }> = {
  "001004001": { ja: ["ミステリー"], tags: ["考えさせられる", "ドキドキ"], baseTier: 40 }, // ミステリー・サスペンス
  "001004002": { ja: ["SF", "ホラー"], tags: ["怖い", "考えさせられる"], baseTier: 40 }, // SF・ホラー
  "001004008": { ja: ["ドラマ"], tags: ["感動", "考えさせられる"], baseTier: 15 }, // 日本の小説
  "001004009": { ja: ["ドラマ"], tags: ["感動", "考えさせられる"], baseTier: 15 }, // 外国の小説
  "001004016": { ja: ["恋愛"], tags: ["感動", "美しい"], baseTier: 15 }, // ロマンス
  "001017005": { ja: ["アクション", "ファンタジー"], tags: ["ワクワク", "ドキドキ"], baseTier: 15 }, // ライトノベル(少年)
  "001017006": { ja: ["恋愛", "ファンタジー"], tags: ["ドキドキ", "感動"], baseTier: 15 }, // ライトノベル(少女)
};
// 「その他」の小説カテゴリ。小説候補と認めるが、具体的なジャンル名は付けない。
const FICTION_CATCHALL_PREFIXES = new Set(["001004015", "001017004"]);
const FICTION_PREFIXES = new Set([...Object.keys(GENRE_PREFIX_MAP), ...FICTION_CATCHALL_PREFIXES]);
const DEFAULT_GENRE = { ja: null, tags: ["楽しい"], baseTier: 15 };

// 小説以外の「本」サブカテゴリ(絵本・新書・図鑑)。物語作品かどうかを判定する
// isFictionCandidate()は小説専用のロジックなので、この3カテゴリを対象に
// 呼び出す時は使わず、該当ジャンルの商品をすべてそのまま候補として扱う
// (呼び出し側でbooks_genre_idにこのマップのキーを渡した時だけ有効になる)。
const DIRECT_BOOK_TYPE_MAP: Record<string, { ja: string; tags: string[]; baseTier: number }> = {
  "001003003": { ja: "絵本", tags: ["楽しい", "美しい"], baseTier: 15 },
  "001003006": { ja: "図鑑", tags: ["考えさせられる", "美しい"], baseTier: 15 },
  "001020": { ja: "新書", tags: ["考えさせられる"], baseTier: 15 },
  // 絵本・図鑑と同じ親(001003=絵本・児童書・図鑑)の兄弟ジャンル。件数を
  // 確認した上で追加(児童書16,649件・児童文庫7,537件・民話747件、
  // しかけ絵本はほぼ0件だったので対象外にした)。
  "001003001": { ja: "児童書", tags: ["楽しい", "考えさせられる"], baseTier: 15 },
  "001003002": { ja: "児童文庫", tags: ["楽しい", "ワクワク"], baseTier: 15 },
  "001003004": { ja: "民話・むかし話", tags: ["考えさせられる", "美しい"], baseTier: 15 },
  // 001009009(美術)は新書と同じくサブジャンルの幅が広い(日本美術/東洋美術/
  // 西洋美術/デザイン/イラスト/美術館等、20,471件)ので、新書と同じ仕組みで
  // サブジャンルごとに実際のジャンル名・気分タグを割り当てる(artInfo参照)。
  // ここのtags/jaは「サブジャンルが未知だった場合」のフォールバック用。
  "001009009": { ja: "美術", tags: ["美しい", "考えさせられる"], baseTier: 15 },
  // 写真は001009009(美術)の子ではなく別の親(001013=写真集・タレント)の
  // 子「動物・自然」(001013003)。同じ親の「グラビアアイドル・タレント
  // 写真集」(001013001)・「その他」(001013002、アイドル写真集が混在)は
  // 美術的な鑑賞目的と言えないので対象外にした(オーナーが写真の追加を
  // 要望したが、アイドル写真集まで混ぜると図鑑のドリル混入と同じ問題になる)。
  "001013003": { ja: "写真", tags: ["美しい", "リラックス"], baseTier: 15 },
  // 建築(001012011=建築学、科学・技術の子)。サンプル調査では上位の大半が
  // 施工管理技士・消防設備士等の資格試験対策本や構造力学の専門教材で、
  // 「図説　建築の歴史」「ガウディの伝言」のような鑑賞寄りの建築書は
  // 少数派だった(オーナーが建築の追加を要望したため調査)。資格・工学系の
  // 語彙をNON_REFERENCE_BOOK_PATTERNSに追加して弾く前提で取り込む。
  "001012011": { ja: "建築", tags: ["美しい", "考えさせられる"], baseTier: 15 },
};

// 美術(001009009)のサブジャンル。ぬりえ・ちぎり絵/切り絵は「鑑賞する美術」
// というより実用の工作寄りで、かつぬりえは既にNON_REFERENCE_BOOK_PATTERNSで
// 弾かれる対象と重複するため、新書のパズル本と同じ考え方で除外する。
const ART_EXCLUDED_SUBGENRES = new Set(["001009009009", "001009009010"]);
const ART_SUBGENRE_NAMES: Record<string, string> = {
  "001009009001": "日本美術",
  "001009009002": "東洋美術",
  "001009009003": "西洋美術",
  "001009009006": "デザイン",
  "001009009007": "イラスト",
  "001009009008": "美術館",
};
const ART_SUBGENRE_TAGS: Record<string, string[]> = {
  "001009009001": ["美しい", "考えさせられる"],
  "001009009002": ["美しい", "考えさせられる"],
  "001009009003": ["美しい", "考えさせられる"],
  "001009009006": ["考えさせられる", "ワクワク"],
  "001009009007": ["楽しい", "美しい"],
  "001009009008": ["美しい", "リラックス"],
};
// 美術のサブジャンルコード(001009009001等)は4階層(12桁)で、新書の
// サブジャンル(001020001等、3階層9桁)と違いgenreSegments()の9桁切り詰めを
// 通すと親の"001009009"に潰れてしまい一致しない(絵本(外国)で一度やった
// のと同じ失敗)。切り詰め無しの生セグメントをstartsWithで見る。
function artInfo(booksGenreId: string | null | undefined): { ja: string; tags: string[]; excluded: boolean } {
  const segs = rawGenreSegments(booksGenreId);
  if (segs.some((s) => [...ART_EXCLUDED_SUBGENRES].some((code) => s.startsWith(code)))) return { ja: "美術", tags: ["美しい"], excluded: true };
  for (const seg of segs) {
    const matchedCode = Object.keys(ART_SUBGENRE_NAMES).find((code) => seg.startsWith(code));
    if (matchedCode) return { ja: ART_SUBGENRE_NAMES[matchedCode], tags: ART_SUBGENRE_TAGS[matchedCode], excluded: false };
  }
  return { ja: "美術", tags: ["美しい", "考えさせられる"], excluded: false };
}

// 新書(001020)はサブジャンルの幅が広く、これまで一律「新書」として取り込んで
// いたため、パズル本(001020003=ホビー・スポーツ・美術。実例:「難関数独」)や
// 絵本・児童書と重複する001020004(実例:「四つ子ぐらし」)まで紛れ込み、
// 「新書」の中身が雑多になっていた(オーナーからの指摘)。この2つは新書
// パイプラインでは取り込まない(絵本・児童書は別途001003003で取り込み済み、
// パズル本の対象ジャンルは今のところ無い)。残りのサブジャンルは実際の
// ジャンル名をそのままgenreに使い、「詳しく絞り込む」で新書だけでも
// 意味のある絞り込みができるようにする(サブジャンル不明時のみ「新書」の
// まま)。
const SHINSHO_EXCLUDED_SUBGENRES = new Set(["001020003", "001020004"]);
const SHINSHO_SUBGENRE_NAMES: Record<string, string> = {
  "001020001": "小説・エッセイ",
  "001020002": "暮らし・健康・料理",
  "001020005": "語学・学習参考書",
  "001020006": "旅行・留学・アウトドア",
  "001020007": "人文・思想・社会",
  "001020008": "ビジネス・経済・就職",
  "001020009": "パソコン・システム開発",
  "001020010": "科学・医学・技術",
  "001020011": "エンタメ",
};
// 新書はサブジャンル名(genre列)こそ実際のものを入れていたが、感情タグは
// directBookType.tags(「考えさせられる」固定)を一律で使っていたため、
// 新書を選ぶと感情タグが実質1種類しか無く「感情検索が無いのと同じ」状態
// だった(オーナー指摘)。せっかくサブジャンルを判定しているので、
// サブジャンルごとに妥当な気分タグを割り当てる(itunes-discover-musicの
// GENRE_TAG_MAPと同じ考え方)。
const SHINSHO_SUBGENRE_TAGS: Record<string, string[]> = {
  "001020001": ["考えさせられる", "感動"], // 小説・エッセイ
  "001020002": ["リラックス", "楽しい"], // 暮らし・健康・料理
  "001020005": ["考えさせられる"], // 語学・学習参考書
  "001020006": ["ワクワク", "美しい"], // 旅行・留学・アウトドア
  "001020007": ["考えさせられる"], // 人文・思想・社会
  "001020008": ["考えさせられる"], // ビジネス・経済・就職
  "001020009": ["考えさせられる"], // パソコン・システム開発
  "001020010": ["考えさせられる", "美しい"], // 科学・医学・技術
  "001020011": ["楽しい", "ワクワク"], // エンタメ
};
function shinshoInfo(booksGenreId: string | null | undefined): { ja: string; tags: string[]; excluded: boolean } {
  const segs = genreSegments(booksGenreId);
  if (segs.some((s) => SHINSHO_EXCLUDED_SUBGENRES.has(s))) return { ja: "新書", tags: ["考えさせられる"], excluded: true };
  for (const seg of segs) {
    if (SHINSHO_SUBGENRE_NAMES[seg]) return { ja: SHINSHO_SUBGENRE_NAMES[seg], tags: SHINSHO_SUBGENRE_TAGS[seg], excluded: false };
  }
  return { ja: "新書", tags: ["考えさせられる"], excluded: false }; // サブジャンルが未知の場合はこれまで通り「新書」のまま取り込む
}

// 「その他」は物語作品以外(占い本・絵本・実用書等)も同居しており、それらは
// 別の上位ジャンルにも重複登録されていることが多い。そこで、この上位
// ジャンル(6桁)が1つでも付いている商品は、小説の他ジャンルと重複していても
// 除外する(実例: 占い本が"001004015/001010007007"のように「小説その他」+
// 「美容・暮らし・健康」の両方を持っていた)。
const EXCLUDED_TOP_PREFIXES = new Set([
  "001002", // 語学・学習参考書
  "001003", // 絵本・児童書・図鑑
  "001005", // パソコン・システム開発
  "001006", // ビジネス・経済・就職
  "001007", // 旅行・留学・アウトドア
  "001008", // 人文・思想・社会
  "001009", // ホビー・スポーツ・美術
  "001010", // 美容・暮らし・健康・料理
  "001012", // 科学・技術
  "001013", // 写真集・タレント
  "001016", // 資格・検定
  "001018", // 楽譜
  "001026", // カレンダー・手帳・家計簿
  "001027", // 文具・雑貨
  "001028", // 医学・薬学・看護学・歯科学
]);

function genreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").map((s) => s.slice(0, 9)).filter(Boolean);
}
function genreInfoFor(booksGenreId: string | null | undefined) {
  for (const seg of genreSegments(booksGenreId)) {
    if (GENRE_PREFIX_MAP[seg]) return GENRE_PREFIX_MAP[seg];
  }
  return DEFAULT_GENRE;
}
// 竹取物語のような古典作品は、学参・人文系の副ジャンル(001002/001008等)と
// 重複して付いていても、具体的な小説ジャンル(001004008=日本の小説等)が
// 明示的に付いていればそれを信頼して残す。「その他」catch-allしか無い場合
// (占い本・絵本が該当)だけ、非物語系ジャンルとの重複を理由に除外する。
function isFictionCandidate(booksGenreId: string | null | undefined): boolean {
  const segs = genreSegments(booksGenreId);
  if (segs.some((seg) => GENRE_PREFIX_MAP[seg])) return true;
  if (!segs.some((seg) => FICTION_CATCHALL_PREFIXES.has(seg))) return false;
  return !segs.some((seg) => EXCLUDED_TOP_PREFIXES.has(seg.slice(0, 6)));
}

// 1商品が複数のジャンルパスを同時に持つことを利用し、他のジャンル(ミステリー・
// SF等)と並行して"001004009"(外国の小説)が付いているかどうかで、翻訳された
// 海外小説かを判定する(実例: 「緋文字(完訳)」は"001019001/001004009")。
const FOREIGN_NOVEL_GENRE = "001004009";
function isForeignNovel(booksGenreId: string | null | undefined): boolean {
  return genreSegments(booksGenreId).includes(FOREIGN_NOVEL_GENRE);
}

// 絵本(001003003)・児童書(001003001)は小説と同様、楽天側に「(日本)」
// 「(外国)」という国別の子ジャンルが存在する(実例: 「はらぺこあおむし」
// booksGenreId="001003003002"=絵本(外国))。ただしこれはGENRE_PREFIX_MAPの
// 3階層コード(9桁)と違い4階層コード(12桁)なので、genreSegments()の
// 9桁切り詰めを通すと(日本)(外国)が同じ9桁に潰れてしまい判定できない。
// 切り詰め無しの生セグメントを別途見る必要がある。
const FOREIGN_BOOK_GENRE_CODES = ["001003003002", "001003001002"]; // 絵本(外国)・児童書(外国)
function rawGenreSegments(booksGenreId: string | null | undefined): string[] {
  return (booksGenreId || "").split("/").filter(Boolean);
}
function isForeignBook(booksGenreId: string | null | undefined): boolean {
  if (isForeignNovel(booksGenreId)) return true;
  const segs = rawGenreSegments(booksGenreId);
  return FOREIGN_BOOK_GENRE_CODES.some((code) => segs.some((s) => s.startsWith(code)));
}

// 絵本(外国)・児童書(外国)以外(図鑑・新書・児童文庫・民話・美術)には
// 国別の子ジャンル自体が存在しないため、isForeignBookだけでは判定できず
// 国別絞り込みが実質"日本"一色になっていた(オーナー指摘)。これらの
// 著者名には翻訳物特有の「カタカナ名・カタカナ名」表記(中点区切りの
// 外国人名の日本語表記、例:「ルイス・キャロル」)が高い確率で出るので、
// それを海外判定の追加signalとして使う(ジャンル側の判定に"OR"で足すだけ
// なので、既に正しく海外判定されているものを日本に戻すことはない)。
function isForeignAuthorName(author: string | null | undefined): boolean {
  if (!author) return false;
  return author.split("/").some((seg) => /[ァ-ヴー]{2,}・[ァ-ヴー]{2,}/.test(seg.trim()));
}

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };
const HEAVY_WORDS = ["惨殺", "拷問", "陵辱", "強姦", "グロテスク", "残虐", "自殺", "虐待"];
const SEXUAL_WORDS = ["性的", "ヌード", "官能", "濡れ場", "エッチ"];

// コミックと違い、小説カテゴリには目録・読者アンケート等の便乗商品は
// あまり無いが、念のため明らかな非小説商品だけ弾いておく。
const NON_NOVEL_TITLE_PATTERNS = ["地球の歩き方", "設定資料集", "公式ガイドブック", "コンプリートガイド"];
function isNonNovelTitle(title: string): boolean {
  return NON_NOVEL_TITLE_PATTERNS.some((w) => title.includes(w));
}

// 図鑑(001003006)はRakuten側にサブジャンルが一切無く絞り込みようが無い
// ため、ドリル・ワーク・カード教材・カレンダー・シール帳のような実用品が
// 「図鑑っぽくない図鑑」として大量に紛れ込んでいた(実データで図鑑817件
// 中59件がこのパターンに一致、オーナー指摘)。絵本・児童書等も同じ親
// ジャンルの便乗品が多いため、directBookType経由の取り込み全体に適用する。
const NON_REFERENCE_BOOK_PATTERNS = [
  "ドリル", "パズル", "プリント", "ワーク", "レッスン", "対決", "検定",
  "カレンダー", "シール", "【特典】", "ぬりえ", "塗り絵", "カード",
  // 美術(001009009)の「その他」等に練習帳・実用書が紛れ込む
  // (例:「美しく正しい字が書ける　ペン字練習帳」が美術として取り込まれた、
  // オーナー指摘)。鑑賞する美術と練習する実用書は別物として除外する。
  "練習", "ペン字", "書道", "硬筆", "毛筆", "美文字", "お手本",
  "試験", "資格",
];
// 建築(001012011)専用の除外語。「工学」「構造」のような語は新書の
// 科学・技術サブジャンル等では正当な一般書にも出てくるため、全直取り込み
// 共通のNON_REFERENCE_BOOK_PATTERNSには入れず、建築だけに絞って適用する。
// サンプル調査(オーナー指摘で実施)では上位の大半が施工管理技士・消防設備士
// 等の資格試験対策本と構造力学・法規等の専門教材だった。
const ARCHITECTURE_EXCLUDED_PATTERNS = [
  "施工", "技士", "過去問", "問題集", "合格", "マニュアル", "法規", "基準法",
  "管工事", "消防設備士", "造園", "給水装置", "コーディネーター", "教材",
  "指針", "仕様書", "力学", "工学", "規準", "確認申請", "技術士", "測量",
  "テキスト", "技術検定", "構造",
  // 1回目のdry_runで上記だけでは残った実務書・業界誌寄りのタイトル
  // (「ビル設備管理実務シリーズ」「SketchUpパーフェクト」「建築設計資料」等)。
  "実務", "早見", "製図", "工務店", "経営戦略", "水文学", "SketchUp", "資料",
  "消防",
];
function isNonArtArchitectureTitle(title: string): boolean {
  return ARCHITECTURE_EXCLUDED_PATTERNS.some((w) => title.includes(w));
}
function isNonReferenceBookTitle(title: string): boolean {
  return NON_REFERENCE_BOOK_PATTERNS.some((w) => title.includes(w));
}

// 絵本・図鑑・児童書・児童文庫・民話・むかし話は、楽天側のジャンルツリーに
// テーマ分岐が無い(絵本は日本/外国の2つだけ、図鑑と民話はジャンル分岐
// ゼロ、児童文庫は出版社レーベル分岐のみ)ため、今まで本の種類1つに
// つき感情タグを固定2個で決め打ちしていた(例:絵本は全1864件が
// [楽しい,美しい]固定)。実際には中身が全然違う(おやすみ系の絵本と
// しかけ絵本は気分が別)のに、感情で絞り込んでも常に同じ2タグしか
// 出てこなかった(オーナー指摘)。商品説明文(synopsis)にはちゃんと
// 中身の違いが出ているので、タイトル+説明文のキーワードから実際に
// 近い気分タグを個別に推定する。
const MOOD_KEYWORDS: Record<string, string[]> = {
  "ワクワク": [
    "しかけ", "とびだす", "ぼうけん", "冒険", "たんけん", "探検", "きょうりゅう", "恐竜",
    "うちゅう", "宇宙", "ロケット", "のりもの", "でんしゃ", "電車", "しょうぼうしゃ", "救急車",
    "へんしん", "変身", "たからもの", "宝物", "たからじま", "まほう", "魔法", "忍者", "にんじゃ",
    "怪盗", "ヒーロー", "どうぶつ", "動物", "こんちゅう", "昆虫",
    // 小説(特にライトノベル・ファンタジー)向け追加語。
    "異世界", "転生", "転移", "魔王", "勇者", "冒険者", "ダンジョン", "バトル", "戦闘", "魔物",
  ],
  "感動": [
    "感動", "涙", "泣ける", "ほろり", "じんわり", "心温まる", "家族の絆", "ありがとう",
    "いのちの大切さ", "命の大切さ", "再会", "旅立ち", "親子の愛",
    // 小説(恋愛・青春)向け追加語。
    "恋", "両想い", "プロポーズ", "青春", "友情", "絆",
  ],
  "リラックス": [
    "おやすみ", "ねむる", "ねんね", "眠り", "子守", "こもりうた", "寝かしつけ", "まったり",
    "ほっこり", "スキンシップ", "あかちゃん", "赤ちゃん", "語りかけ",
  ],
  "怖い": [
    "おばけ", "ゆうれい", "幽霊", "ようかい", "妖怪", "おに", "鬼", "やみ", "闇",
    "のろい", "呪い", "ホラー", "魔女", "こわい話", "怖い話",
    // 小説(ホラー・サスペンス)向け追加語。
    "猟奇", "惨劇", "恐怖",
  ],
  "美しい": [
    "うつくしい", "美しい", "きれい", "綺麗", "花", "はな", "自然", "しぜん", "四季",
    "季節", "星空", "海の", "虹", "名画", "絵画", "しょくぶつ", "植物",
  ],
  "ドキドキ": [
    "どきどき", "ハラハラ", "スリル", "追いかけ", "対決", "勝負", "レース", "競争", "サスペンス",
    // 小説(ミステリー)向け追加語。
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
    // 小説向け追加語。
    "復讐", "裏切り", "運命", "正義", "罪",
  ],
  "楽しい": [
    "たのしい", "楽しい", "あそぶ", "遊ぶ", "ゆかい", "愉快", "うた", "歌", "おどる", "踊る",
    "パーティー", "えがお", "笑顔",
  ],
};
// キーワードが1つも当たらない場合は本の種類ごとの既定2タグにフォールバック、
// 1つしか当たらなかった場合は既定タグから不足分を補って必ず2タグ返す。
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
// このロジックを適用する本の種類(感情ごとのテーマ分岐がジャンル側に
// 無いもの)。新書・美術はサブジャンルで既に実ジャンル名ベースのタグが
// 付くので対象外。写真は分岐が無いので対象にする。
const MOOD_INFER_BOOK_TYPES = new Set(["001003003", "001003006", "001003001", "001003002", "001003004", "001013003", "001012011"]);

function estimateExpression(genreId: string | null | undefined, caption: string): { level: number; reasonTags: string[]; basis: string } {
  const info = genreInfoFor(genreId);
  let level = info.baseTier;
  let basis = "genre-demographic";
  const reasons = new Set<string>();

  if (HEAVY_WORDS.some((w) => caption.includes(w))) {
    level = Math.max(level, TIER.INTENSE);
    reasons.add("violence");
    basis = "keyword-heavy";
  } else if (SEXUAL_WORDS.some((w) => caption.includes(w))) {
    level = Math.max(level, TIER.STRONG);
    reasons.add("sexual");
    basis = "keyword-sexual";
  }
  return { level, reasonTags: Array.from(reasons), basis };
}

// 「(グッズ名)付き　(本来のタイトル)」のように、特典名が先頭に付いた形で
// 返ってくる商品があるため、シリーズ名判定の前にこの先頭プレフィックスを取り除く。
function stripBonusPrefix(title: string): string {
  const m = title.match(/^.{1,20}付き[\s　]+(.+)$/u);
  return m ? m[1] : title;
}

// 「【バーゲン本】」「【サイン本】」のような小売り上の状態タグは作品名の
// 一部ではないため、表示用タイトルから取り除く。
// 「【楽天ブックス限定特典】彼方から 小冊子付き愛蔵版 4(ミニ複製原画風
// カード1枚)」のような特典グッズのSKUは、括弧内が特典の説明文になって
// いるため、タグを取り除いた後にその説明もまとめて切り落とす。
function stripRetailTags(title: string): string {
  const m = title.match(/^【(バーゲン本|サイン本|楽天ブックス限定特典|特典)】\s*(.+)$/u);
  if (!m) return title.trim();
  const rest = m[2];
  const parenIdx = rest.search(/[\(（]/u);
  return (parenIdx === -1 ? rest : rest.slice(0, parenIdx)).trim();
}

// ISBN(978/979で始まる13桁)ではなく楽天独自のJANコードが振られている
// 商品は、しおり・ステッカー・複製原画カードのような特典グッズのSKUで
// あることが多く、書影の代わりに「特典の内容を説明するテキストカード」
// 画像が入っていることが多い(実際の表紙ではない)。そのため表紙画像には
// 使わない。
function isGoodsIsbn(isbn: string | null | undefined): boolean {
  return !!isbn && !/^97[89]/.test(isbn);
}

// 「全12巻セット」「（3冊）」のような、まとめ買い用の巻数セット表記を
// 持つ商品はまとめ買いSKUであり、通常の単巻とは別にシリーズ代表として
// 選ばれると「作品名（3冊）」のような不自然な表示になってしまうため、
// 代表候補として採用しない。以前はstrip-and-compare方式だったが、
// 巻数と修飾語の間に空白がある表記(「全16巻 完結セット」等)や修飾語の
// 後に注記が続く表記を取りこぼしていたため、まとめ買いを示す語が
// どこかに含まれるかを見る方式に切り替えた。
function isBundleTitle(title: string): boolean {
  return /(全[0-9０-９]+[巻冊集]|[0-9０-９]+[-－][0-9０-９]+[巻冊][\s　]*セット|[0-9０-９]+[巻冊][\s　]*セット|完結セット)/u.test(title);
}

// タイトルから巻数表記("本好きの下剋上 8"等)以降を切り捨ててシリーズ名を推定する。
// 楽天のseriesNameは(漫画と同じく)出版レーベル名が入っていることが多く
// 作品名として使えないため、シリーズ名の判定はtitleベースの推定だけに頼る。
function stripVolumeSuffix(rawTitle: string): string {
  const title = stripRetailTags(stripBonusPrefix(rawTitle));
  // 「新・人間革命（第21巻）」のような「第N巻」表記(古い作品の重版・文庫化で
  // よく使われる)。これを見逃すと同じ作品の巻違いが別作品として重複登録される。
  const withKanjiVolume = title.match(/^(.*?)[\s　]*[\(（]?第[0-9０-９]+[巻冊集][\)）]?\s*$/u);
  if (withKanjiVolume) return withKanjiVolume[1].trim();
  const withParenVolume = title.match(/^(.*?)[\s　]*[\(（][0-9０-９]+[\)）]/u);
  if (withParenVolume) return withParenVolume[1].trim();
  const withTrailingVolume = title.match(/^(.*?)[\s　]+[0-9０-９]+\s*$/u);
  if (withTrailingVolume) return withTrailingVolume[1].trim();
  // 「角川まんが学習シリーズ　日本の歴史　11　黒船と開国　江戸時代後期」の
  // ように、巻数がタイトルの末尾ではなく途中(副題の前)に来る図鑑・児童書系の
  // シリーズがあり、これまでは1冊ずつ別作品として重複登録されていた
  // (オーナー指摘)。数字の前後が両方とも空白で区切られている(=単独の
  // トークンになっている)場合だけ巻数とみなし、それより前をシリーズ名と
  // する。「ゴルゴ13」「モブサイコ100」「2001年宇宙の旅」のように数字が
  // 文字にくっついている場合は空白が無く一致しないため、誤って巻数判定
  // されることはない。
  const withMiddleVolume = title.match(/^(.+?)[\s　]+[0-9０-９]{1,3}[\s　]+\S.*$/u);
  if (withMiddleVolume) return withMiddleVolume[1].trim();
  // スペース無しで巻数が直接くっつく表記は、数字自体がタイトルの一部の
  // 作品(「ゴルゴ13」「モブサイコ100」等)と区別が付かないため切り落とさない。
  return title.trim();
}

function extractVolumeNumber(title: string): number {
  const match = title.match(/第([0-9０-９]+)[巻冊集]|[\(（]([0-9]+)[\)）]|[\s　]([0-9]+)\s*$/);
  if (!match) return 0;
  const num = match[1] || match[2] || match[3];
  return num ? parseInt(num, 10) : 0;
}

// 楽天のsalesDateは未発売(予約)の日付や、日付未定の商品にはダミーの遠未来
// 日付が入っていることがある。日本で未発売の新作は発見導線に出さない方針
// のため、salesDateが実行時点より未来の商品は取り込み対象から除外する。
function parseSalesDate(salesDate: string | null | undefined): Date | null {
  const m = String(salesDate || "").match(/([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})日/);
  if (!m) return null;
  const date = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)));
  return isNaN(date.getTime()) ? null : date;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rakutenFetch(params: Record<string, string>) {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", RAKUTEN_APP_ID);
  url.searchParams.set("accessKey", RAKUTEN_ACCESS_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Referer: SITE_URL, Origin: SITE_URL.replace(/\/$/, "") },
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        await sleep(1500);
        continue;
      }
      if (res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      const body = await res.text();
      return { error: true, status: res.status, body };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

async function selectAllRows(supabase: any, table: string, columns: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

const SYNOPSIS_MAX_LEN = 400;

Deno.serve(async (req: Request) => {
  try {
    const {
      pages = [1],
      hits = 30,
      sort = "sales", // standard | sales | -releaseDate | +releaseDate | reviewCount | reviewAverage
      books_genre_id = "001004", // 小説・エッセイ("001017"を渡せばライトノベル)
      dry_run = true,
    } = await req.json().catch(() => ({}));

    // DIRECT_BOOK_TYPE_MAPのキー(絵本=001003003・図鑑=001003006・新書=001020)が
    // 渡された時は、小説かどうかの判定(isFictionCandidate)を通さず、
    // そのジャンルの商品をそのまま候補として扱う。genreにも「絵本」等を
    // そのまま入れて、フロント側でジャンルチップとして選べるようにする
    // (is_novelは変えないので、小説と同じ「小説」モード内に混在する)。
    const directBookType = DIRECT_BOOK_TYPE_MAP[books_genre_id];

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const existingRows = await selectAllRows(supabase, "movies", "title, release_year");
    // 既存タイトルは、以前このstripVolumeSuffix修正が入る前に「（第21巻）」の
    // ような巻数付きのまま登録された行が混じっているため、既存タイトル側も
    // stripVolumeSuffixで正規化してから比較し、クロスバッチ重複を防ぐ。
    const existingTitles = new Set(existingRows.map((r: any) => normalizeTitle(stripVolumeSuffix(r.title))));

    const candidates: any[] = [];
    for (const page of pages) {
      const data = await rakutenFetch({
        booksGenreId: books_genre_id,
        hits: String(hits),
        page: String(page),
        sort,
      });
      if (data?.error) {
        return new Response(JSON.stringify({ error: "rakuten_api_error", status: data.status, body: data.body }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      const items = (data?.Items || []).map((w: any) => w.Item);
      candidates.push(...items);
      await sleep(300);
    }

    // シリーズ単位にグルーピングし、各シリーズの代表(最も若い巻)だけを残す。
    let nonFictionSkipped = 0;
    const groups = new Map<string, any[]>();
    for (const c of candidates) {
      if (!directBookType && !isFictionCandidate(c.booksGenreId)) { nonFictionSkipped++; continue; }
      const seriesKey = stripVolumeSuffix(c.title) || (c.seriesName && c.seriesName.trim()) || c.title;
      if (!seriesKey) continue;
      const list = groups.get(seriesKey) || [];
      list.push(c);
      groups.set(seriesKey, list);
    }

    const representatives: { key: string; item: any }[] = [];
    for (const [key, list] of groups.entries()) {
      // まとめ買いセット(全N冊セット等)や特典グッズのSKU(ISBNが978/979で
      // 始まらない)は、通常の単巻商品より後回しにする(特典グッズは表紙が
      // テキストカード画像なだけでなく、そもそも「作品」ではなく販促グッズ
      // 付きの一SKUに過ぎないため)。
      list.sort((a, b) => {
        const bundleDiff = Number(isBundleTitle(a.title)) - Number(isBundleTitle(b.title));
        if (bundleDiff !== 0) return bundleDiff;
        const goodsDiff = Number(isGoodsIsbn(a.isbn)) - Number(isGoodsIsbn(b.isbn));
        if (goodsDiff !== 0) return goodsDiff;
        return extractVolumeNumber(a.title) - extractVolumeNumber(b.title);
      });
      representatives.push({ key, item: list[0] });
    }

    const fresh = representatives.filter((r) => !existingTitles.has(normalizeTitle(r.key)));

    const now = new Date();
    const rows: any[] = [];
    const estimates: any[] = [];
    const skipped: any[] = [];
    const isShinsho = books_genre_id === "001020";
    const isArt = books_genre_id === "001009009";
    for (const { key, item } of fresh) {
      // 非小説タイトルのブラックリスト(地球の歩き方等)は小説パイプライン用
      // なので、絵本・新書・図鑑では適用しない。
      if (!directBookType && isNonNovelTitle(item.title)) {
        skipped.push({ key, reason: "non_novel_title" });
        continue;
      }
      // 絵本・図鑑・児童書等(directBookType経由)側はこちら: ドリル・ワーク・
      // カード教材等の実用品ブラックリスト。
      if (directBookType && isNonReferenceBookTitle(item.title)) {
        skipped.push({ key, reason: "non_reference_book_title" });
        continue;
      }
      if (books_genre_id === "001012011" && isNonArtArchitectureTitle(item.title)) {
        skipped.push({ key, reason: "architecture_exam_or_textbook" });
        continue;
      }
      if (isShinsho && shinshoInfo(item.booksGenreId).excluded) {
        // パズル本・絵本児童書と重複するサブジャンルは新書として取り込まない。
        skipped.push({ key, reason: "shinsho_excluded_subgenre" });
        continue;
      }
      if (isArt && artInfo(item.booksGenreId).excluded) {
        // ぬりえ・ちぎり絵/切り絵は鑑賞美術というより工作寄りなので取り込まない。
        skipped.push({ key, reason: "art_excluded_subgenre" });
        continue;
      }
      if (isBundleTitle(item.title)) {
        // グループ内に単巻商品が1つも無く、まとめ買いセットしか無かった場合。
        skipped.push({ key, reason: "bundle_set_only" });
        continue;
      }
      const saleDate = parseSalesDate(item.salesDate);
      if (saleDate && saleDate.getTime() > now.getTime()) {
        skipped.push({ key, reason: "unreleased", salesDate: item.salesDate });
        continue;
      }
      const caption = (item.itemCaption || "").trim();
      const genreInfo = isShinsho
        ? { ja: [shinshoInfo(item.booksGenreId).ja], tags: shinshoInfo(item.booksGenreId).tags, baseTier: directBookType.baseTier }
        : isArt
        ? { ja: [artInfo(item.booksGenreId).ja], tags: artInfo(item.booksGenreId).tags, baseTier: directBookType.baseTier }
        : directBookType
        ? {
            ja: [directBookType.ja],
            tags: MOOD_INFER_BOOK_TYPES.has(books_genre_id)
              ? inferMoodTags(item.title, item.itemCaption, directBookType.tags)
              : directBookType.tags,
            baseTier: directBookType.baseTier,
          }
        : (() => {
            // 小説(GENRE_PREFIX_MAP経由)も本の種類と同じく、今まではジャンル
            // 1つにつき感情タグを固定2個で決め打ちしていた(例:「ドラマ」
            // 6566件が全件[感動,考えさせられる]固定)。感情タグを複数組み合わせると
            // 該当ジャンルの組み合わせが存在しない限り何も出てこない状態
            // だった(オーナー指摘)。絵本等と同じキーワード推定を適用する。
            const base = genreInfoFor(item.booksGenreId);
            return { ja: base.ja, tags: inferMoodTags(item.title, item.itemCaption, base.tags), baseTier: base.baseTier };
          })();
      const year = saleDate ? saleDate.getUTCFullYear() : null;
      // 表紙画像が無い商品には楽天の「NO IMAGE」プレースホルダー画像が
      // 入っているため、そのまま表示すると全作品同じ灰色画像が並んでしまう。
      // ファイル名にnoimageが含まれる場合はposter_pathをnullにして、
      // サイト側のデフォルト表示(色付きの仮ポスター)に任せる。
      // 特典グッズのSKU(ISBNが978/979で始まらない)は、書影ではなく
      // 「特典内容を説明するテキストカード」画像が入っていることが多いため、
      // 表紙として使わない。
      const isNoImage = (url: string | null | undefined) => !url || /noimage/i.test(url);
      const coverUrl = isGoodsIsbn(item.isbn)
        ? null
        : !isNoImage(item.largeImageUrl)
        ? item.largeImageUrl
        : !isNoImage(item.mediumImageUrl)
        ? item.mediumImageUrl
        : null;

      rows.push({
        title: key,
        release_year: year,
        emotion_tags: genreInfo.tags,
        genre: genreInfo.ja,
        director: item.author || null,
        cast_members: null,
        // 以前は全件一律で"日本"にしていたため、翻訳された海外小説
        // (例:「緋文字（完訳）」booksGenreId="001019001/001004009"のように
        // 他のジャンルパスと同時に"001004009"(外国の小説)も持つ)まで
        // 日本作品として記録されてしまい、国で絞り込むと海外小説が
        // 一切出てこなかった。genreSegmentsは既に"/"区切りの全パスを
        // 見ているので、この中に外国の小説ジャンルが含まれるかどうかで
        // 判定する。
        country: (isForeignBook(item.booksGenreId) || isForeignAuthorName(item.author)) ? "海外" : "日本",
        synopsis: caption ? caption.slice(0, SYNOPSIS_MAX_LEN) : null,
        poster_path: coverUrl,
        japan_release_date: null,
        japan_release_checked_at: null,
        keywords: null,
        keywords_checked_at: new Date().toISOString(),
        series: null,
        series_checked_at: null,
        media_type: "novel",
        is_anime: false,
        is_drama: false,
        is_manga: false,
        is_novel: true,
        _key: key,
      });

      const est = estimateExpression(item.booksGenreId, caption);
      estimates.push({ key, level: est.level, reasonTags: est.reasonTags, basis: est.basis, isbn: item.isbn });
    }

    let inserted = 0;
    let estimatesInserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ _key, ...rest }) => rest);
      const { data: insertedRows, error: insertErr } = await supabase
        .from("movies")
        .insert(insertPayload)
        .select("id, title");
      if (insertErr) throw insertErr;
      inserted = insertedRows?.length || 0;

      if (insertedRows?.length) {
        const idByTitle = new Map(insertedRows.map((r: any) => [normalizeTitle(r.title), r.id]));
        const estimateRows = estimates
          .map((e) => {
            const movieId = idByTitle.get(normalizeTitle(e.key));
            if (!movieId) return null;
            return {
              movie_id: movieId,
              expression_level: e.level,
              reason_tags: e.reasonTags,
              source: `rakuten_novel_batch(${new Date().toISOString().slice(0, 10)}):${e.basis};isbn=${e.isbn || ""}`,
              method: "rating_mapping",
            };
          })
          .filter(Boolean);
        if (estimateRows.length) {
          const { error: estErr, count } = await supabase
            .from("movie_expression_estimates")
            .upsert(estimateRows, { onConflict: "movie_id", ignoreDuplicates: true, count: "exact" });
          if (estErr) throw estErr;
          estimatesInserted = count ?? estimateRows.length;
        }
      }
    }

    return new Response(
      JSON.stringify({
        dry_run,
        candidates_fetched: candidates.length,
        non_fiction_skipped: nonFictionSkipped,
        series_grouped: representatives.length,
        duplicates_skipped: representatives.length - fresh.length,
        unreleased_skipped: skipped.length,
        would_insert: rows.length,
        inserted,
        estimates_inserted: estimatesInserted,
        rows: dry_run ? rows : undefined,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err), stack: err?.stack }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

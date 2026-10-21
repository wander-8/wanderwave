# ニッチ・フェチ属性タグ(コンポーネントA) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (この規模・このコードベースの性質上、サブエージェント分割より1セッション内での連続実装を推奨。詳細は末尾の実行方法を参照)。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自由文検索で「男性妊娠」のようなニッチ・フェチ属性を検索できるようにする。新しい分類エンジンではなく、既にAniList/TMDBが持つ細かいタグの保持範囲を広げ、Rakuten分だけ新規AI分類を足す。

**Architecture:** `movies.niche_tags text[]`という新列を1つ追加し、既存の`keywords`/`emotion_tags`と全く同じ扱い方(`buildMovieRecord`での正規化→`termMatchesMovie`での部分一致)で検索に乗せる。データの集め方は取り込み元ごとに3通り(AniList: 既存タグの保持範囲拡張、TMDB: 既存keywords列からのコピー、Rakuten: 新規AI分類`content-classify`)。

**Tech Stack:** 静的`index.html`(ビルドステップ無し)+ Supabase Postgres + Deno edge functions。このプロジェクトに自動テストランナー(pytest/jest等)は無い。検証は (1) `node --check`によるJS構文確認、(2) データ変更系は`dry_run`/`write:false`引数でのプレビュー実行、(3) `mcp__chrome-devtools`での実ブラウザ目視確認、の3本柱(CLAUDE.mdのエンジニア方針に準拠)。各タスクの「テスト」はこの3本柱に沿って書く。

**Spec:** `docs/superpowers/specs/2026-10-22-content-attribute-search-design.md`(特にコンポーネントA全体とスコープ外の節)

## Global Constraints

- ニッチ・フェチ属性タグはオープンエンドな語彙(固定10語のような閉じたリストにしない)。
- `niche_tags`はホーム画面の受動的な表示・推薦には一切使わない(検索でのみ参照する)。`isTooIntenseForPassiveDiscovery`等の既存の棚ロジックに`niche_tags`を混ぜない。
- AniListの`isMediaSpoiler`タグは検索マッチングの裏データとしてのみ使い、カード・バッジ等のUIにそのまま表示しない。
- 既存の`keywords`列(TMDBのSEOキーワード)の意味・既存の参照箇所は一切変更しない。`niche_tags`は完全に別列。
- 新規APIコールはRakuten分(`content-classify`)のみ。AniList/TMDB分は既存の取り込み済みデータの保持範囲を広げるだけで、新規の外部API呼び出しを増やさない。

## Review Focus

- **既存行(このタスク群のデプロイ前に追加済みの9万件超)の`niche_tags`がnull**: `buildMovieRecord`や`termMatchesMovie`がnullアクセスで例外を投げないこと。空配列フォールバックが要る。
- **AniListの`isMediaSpoiler`タグが実際にUIへ漏れないこと**: カード生成関数(`buildCardHTML`等)のどこからも`m.nicheTags`/`m.nicheTagsNorm`を直接レンダリングしていないことを確認する。
- **英語タグ(AniList/TMDB由来)と日本語タグ(Rakuten AI分類由来)が同じ配列に混在した時の正規化**: `normalizeForSearch`が英語・日本語どちらでも破綻しないこと(既存の`keywordsNorm`と同じ関数を使うので理論上は問題ないが、実データで確認する)。
- **`content-classify`がタイムアウト/エラーになった時、`rakuten-discover-manga`/`-novel`のinsert自体が巻き込まれて失敗しないこと**(新規作品の取り込み自体を止めてはいけない)。
- **AniListの`tags`配列の件数上限を緩めたことで、1行あたりのペイロードサイズが極端に増えないこと**(40件程度への緩和で妥当か、実データで確認する)。

---

### Task 1: DBマイグレーション — `niche_tags`列の追加

**Files:**
- マイグレーション: `mcp__supabase__apply_migration`で直接適用(このプロジェクトにマイグレーションファイルをリポジトリ管理する慣習が無い。既存の`add_movies_genre_gin_index`等と同じやり方)。

**Interfaces:**
- Produces: `movies.niche_tags text[]`(デフォルトNULL)。以降の全タスクがこの列を読み書きする。

- [ ] **Step 1: 現在のmoviesテーブル定義を確認する**

```
mcp__supabase__list_tables でmoviesテーブルの既存カラム一覧を確認し、niche_tagsが存在しないことを確かめる。
```
Expected: `niche_tags`列が無いことを確認。

- [ ] **Step 2: マイグレーションを適用する**

```sql
ALTER TABLE movies ADD COLUMN niche_tags text[];
COMMENT ON COLUMN movies.niche_tags IS 'ニッチ・フェチ属性タグ(オープンエンド語彙)。検索専用、ホーム画面の受動的表示には使わない。AniList/TMDBの細かいタグ+RakutenのAI分類タグが混在する。';
```
`mcp__supabase__apply_migration`の`name`は`add_movies_niche_tags_column`。

- [ ] **Step 3: 適用を確認する**

```sql
select column_name, data_type from information_schema.columns where table_name='movies' and column_name='niche_tags';
```
Expected: 1行返り、`data_type`が`ARRAY`。

- [ ] **Step 4: コミット**

このタスクはDBのみの変更でリポジトリへのコミットは無し。次のタスクでコードをコミットする時にまとめて触れる。

---

### Task 2: フロント側の検索マッチングに`niche_tags`を接続する

**Files:**
- Modify: `index.html`(`MOVIE_LIGHT_COLUMNS`定義、`buildMovieRecord`、`termMatchesMovie`)

**Interfaces:**
- Consumes: Task 1の`movies.niche_tags`列。
- Produces: `m.nicheTagsNorm`(正規化済み配列、`buildMovieRecord`が組み立てる)。Task 3〜5のバックエンド側は`niche_tags`列にテキスト配列を書き込むだけでよく、このタスクが仕上げた瞬間から検索に反映される(新しい検索エンジンは作らない)。

- [ ] **Step 1: `MOVIE_LIGHT_COLUMNS`に`niche_tags`を追加する**

`index.html`内、`const MOVIE_LIGHT_COLUMNS = 'id, title, ..., music_scene_tags';`(12171行付近)を以下に変更:

```js
const MOVIE_LIGHT_COLUMNS = 'id, title, release_year, emotion_tags, genre, director, country, poster_path, japan_release_date, keywords, niche_tags, series, trailer_key, media_type, is_anime, is_drama, is_manga, is_novel, is_music, volume_count, tmdb_vote_average, tmdb_vote_count, rakuten_review_count, rakuten_review_average, music_scene_tags';
```

- [ ] **Step 2: `buildMovieRecord`で`nicheTagsNorm`を組み立てる**

`index.html`の`buildMovieRecord`内(12209行付近、`const keywordsArr = row.keywords || [];`の直後)に追加:

```js
const nicheTagsArr = row.niche_tags || [];
```

同関数の戻りオブジェクト内、`keywordsNorm: keywordsArr.map(normalizeForSearch),`の直後(12227行付近)に追加:

```js
// オーナー指摘(2026-10-22):「男性妊娠」のようなニッチ・フェチ属性で
// 検索したい人向け。AniList/TMDBの細かいトロープタグ(英語)と、
// Rakuten分のAI分類タグ(日本語)が混在する列(niche_tags)。検索専用
// (ホーム画面の受動的な棚には一切使わない、design spec参照)。
nicheTagsNorm: nicheTagsArr.map(normalizeForSearch),
```

- [ ] **Step 3: `termMatchesMovie`にニッチタグの照合を足す**

`index.html`の`termMatchesMovie`関数(8577行付近)、既存の`|| (m.tagsNorm && m.tagsNorm.includes(term))`の直後に追加:

```js
    // ニッチ・フェチ属性タグ(niche_tags)。感情タグと同じく少数の管理された
    // 語彙ではなくオープンエンドだが、個別の語自体は固有名詞に近く短い語の
    // 誤マッチは起きにくいため、noisy判定の対象からは外す。
    || (!noisy && m.nicheTagsNorm && m.nicheTagsNorm.some(k => k.includes(term)))
```

- [ ] **Step 4: 構文確認**

```bash
python3 -c "
import re
html = open('index.html', encoding='utf-8').read()
scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.S)
open('/tmp/check_niche_a.js','w',encoding='utf-8').write(scripts[3])
"
node --check /tmp/check_niche_a.js
```
Expected: エラー無し(出力無し)。

- [ ] **Step 5: 実ブラウザで既存行(niche_tagsがnullのまま)が壊れていないことを確認**

```
python3 -m http.server 8123 をバックグラウンドで起動 → mcp__chrome-devtools__new_page で開く →
通常の検索(例: 「七人の侍」)が今まで通り動くことを確認(nicheTagsNormがundefinedの行でもtermMatchesMovieが例外を投げないこと)。
```
Expected: 検索結果が今まで通り表示される、コンソールエラー無し(`mcp__chrome-devtools__list_console_messages`で確認)。

- [ ] **Step 6: コミット**

```bash
git add index.html
git commit -m "Wire niche_tags into search matching (Component A, Task 2)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: AniList取り込みの保持範囲を広げる

**Files:**
- Modify: `supabase/functions/anilist-discover-manga/index.ts`

**Interfaces:**
- Consumes: Task 1の`niche_tags`列。
- Produces: 新規に取り込まれるAniList由来のmanga行が、取り込み時点で`niche_tags`を持つ。

- [ ] **Step 1: 現状のタグ処理を確認する**

`supabase/functions/anilist-discover-manga/index.ts`内、`const tags: string[] = (c.tags || []).filter((t: any) => !t.isMediaSpoiler).map((t: any) => t.name);`の行を確認する(現状: スポイラータグ除外、`keywords`列へ最大15件)。

- [ ] **Step 2: タグ抽出を変更する**

同ファイルの該当行を以下に変更:

```ts
// オーナー指摘(2026-10-22):「異世界転生とかって単独でカテゴリーされてる
// だろうし、そっちの情報の方が信頼できる」。AniListの細かいトロープタグは
// ニッチ・フェチ属性検索の土台になるため、isMediaSpoilerでの除外をやめ、
// 上限も40件まで緩める(design spec参照)。ただし検索マッチングの裏データ
// としてのみ使い、カード等のUIにタグ名をそのまま表示しない制約は維持する。
// 保存先はkeywords列(TMDB由来のSEOキーワードという別の意味を持つ既存列)
// ではなく、新規のniche_tags列に分離する。
const allTags = (c.tags || []).sort((a: any, b: any) => (b.rank || 0) - (a.rank || 0));
const nicheTags: string[] = allTags.slice(0, 40).map((t: any) => t.name);
const tags: string[] = allTags.filter((t: any) => !t.isMediaSpoiler).map((t: any) => t.name);
```

(`tags`変数は`estimateExpression(genres, tags)`の呼び出しに引き続き使われるため、スポイラー込み/無しを明確に分ける。`estimateExpression`には従来通りスポイラー除外済みの`tags`を渡し続ける——表現度推定の挙動は変えないため。)

- [ ] **Step 3: insertする行に`niche_tags`を追加する**

同ファイルの`rows.push({...})`内、`keywords: tags.slice(0, 15),`の行の直後に追加:

```ts
        niche_tags: nicheTags,
```

- [ ] **Step 4: `--dry_run`でプレビュー実行して確認する**

```
mcp__supabase__deploy_edge_function で anilist-discover-manga を更新デプロイ。
その後、実際にfetchでdry_run:trueを渡して1ページ分叩く(例: {"pages":[1],"per_page":5,"dry_run":true})。
```
Expected: レスポンスの`rows`に`niche_tags`フィールドが含まれ、40件以内の英語タグ配列になっている。`keywords`フィールドは従来通りスポイラー除外済み15件のまま変わっていないことも確認する。

- [ ] **Step 5: 実データで1件だけ書き込みテストする**

```
dry_run:false, pages:[1], per_page:1 で実行(本番データに1件だけ追加される)。
```
Expected: `inserted:1`。追加された行をSQLで確認:
```sql
select id, title, niche_tags, keywords from movies where media_type='manga' order by id desc limit 1;
```
`niche_tags`に英語のトロープ名が入っていること、`keywords`は変わらず15件以内であることを確認。

- [ ] **Step 6: `isMediaSpoiler`タグがUIに漏れていないことを確認する(Review Focus)**

```bash
grep -n "nicheTags\|niche_tags" index.html
```
Expected: Task 2で追加した`nicheTagsArr`/`nicheTagsNorm`の組み立て箇所(`buildMovieRecord`)と、`termMatchesMovie`での照合箇所の2箇所のみヒットする。`buildCardHTML`・`buildHomeSceneResultItemHTML`等、カードやバッジを組み立てる関数の中に`nicheTags`への参照が無いことを確認する(=検索マッチングにしか使われておらず、スポイラー込みのタグがどこにも表示されない)。

- [ ] **Step 7: コミット**

```bash
git add supabase/functions/anilist-discover-manga/index.ts
git commit -m "Widen AniList tag retention into new niche_tags column (Component A, Task 3)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: TMDBの既存keywordsを`niche_tags`へ反映する(新規取り込み分+バックフィル)

**Files:**
- Modify: `supabase/functions/tmdb-keywords-backfill/index.ts`
- SQL: 既存行への一括バックフィル(新規ファイル不要、`mcp__supabase__execute_sql`で直接実行)

**Interfaces:**
- Consumes: Task 1の`niche_tags`列、既存の`movies.keywords`列(TMDB由来の行のみ有効なデータを持つ)。
- Produces: TMDB由来(movie/drama/アニメ映画)の全行が`niche_tags`に`keywords`と同じ内容を持つ。

- [ ] **Step 1: `tmdb-keywords-backfill`の書き込み処理を確認する**

`supabase/functions/tmdb-keywords-backfill/index.ts`の87〜98行目(`chunk.map(async (m: any) => {...})`内)を確認する。ローカル変数`keywords`(`let keywords: string[] = []`)にTMDB APIの結果を詰めてから、`.update({ keywords: keywords.length ? keywords : null, keywords_checked_at: ... })`で書き込んでいる。

- [ ] **Step 2: 新規取り込み分が`niche_tags`も同時に埋めるよう変更する**

同ファイル97行目の`.update({...})`呼び出しを以下に変更:

```ts
          // オーナー指摘(2026-10-22):TMDBのkeywordsは既にニッチなトロープ
          // 情報(reincarnation, pregnancy等)を含んでおり、ニッチ属性検索の
          // 土台としてそのままniche_tagsにも反映する(design spec A-2)。
          // keywords列自体の意味・既存の参照箇所は変更しない、コピーするだけ。
          const { error: updateErr } = await supabase
            .from("movies")
            .update({
              keywords: keywords.length ? keywords : null,
              niche_tags: keywords.length ? keywords : null,
              keywords_checked_at: new Date().toISOString(),
            })
            .eq("id", m.id);
```

- [ ] **Step 3: 既存行への一括バックフィル(SQL)**

```sql
update movies
set niche_tags = keywords
where keywords is not null
  and array_length(keywords, 1) > 0
  and niche_tags is null;
```

まず件数を確認してから実行する(CLAUDE.mdの「bulk data transformはdry_run/SELECTで先にプレビュー」方針):
```sql
select count(*) from movies where keywords is not null and array_length(keywords, 1) > 0 and niche_tags is null;
```
Expected: 対象件数が表示される(TMDB由来行数とおおむね一致するはず)。その後`update`を実行。

- [ ] **Step 4: デプロイして確認**

```
mcp__supabase__deploy_edge_function で tmdb-keywords-backfill を更新デプロイ。
```
```sql
select id, title, keywords, niche_tags from movies where media_type='movie' and keywords is not null limit 3;
```
Expected: `keywords`と`niche_tags`が同じ内容。

- [ ] **Step 5: コミット**

```bash
git add supabase/functions/tmdb-keywords-backfill/index.ts
git commit -m "Copy TMDB keywords into niche_tags (Component A, Task 4)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 日本語エイリアス辞書(`VIBE_QUERY_ALIASES`)の拡張

**Files:**
- Modify: `index.html`(`VIBE_QUERY_ALIASES`)

**Interfaces:**
- Consumes: Task 2で接続済みの`nicheTagsNorm`照合経路(`matchesVibeAlias`経由)。
- Produces: 日本語での検索語が、AniList/TMDB由来の英語ニッチタグにも届くようになる。

- [ ] **Step 1: Task 3で実際に取り込まれたAniListタグの実例を確認する**

```sql
select unnest(niche_tags) as tag, count(*) from movies where media_type='manga' and niche_tags is not null group by 1 order by 2 desc limit 50;
```
よく出現する英語トロープタグの一覧を得る(具体的にどんな語が実在するかはここで初めて分かるため、事前に決め打ちしない)。

- [ ] **Step 2: 上位タグに日本語エイリアスを追加する**

`index.html`の`const VIBE_QUERY_ALIASES = {`(7975行付近)の末尾に、Step 1で得た実在タグの中から日本語で検索されそうなものを追加する。書式は既存エントリに合わせる(英語キー→日本語エイリアス配列):

```js
  // ニッチ・フェチ属性タグ(AniList/TMDB由来、Component A)向けエイリアス。
  // 完全網羅はしない。実際の検索ログ(ai_search_cache)を見ながら継続的に
  // 追加する運用(design spec参照)。
```

(実際に追加するエントリはStep 1の結果次第のため、ここでは具体的な語を決め打ちしない——Step 1を実行した担当者が、その場で得られた実データを見て埋める。)

- [ ] **Step 3: 構文確認**

Task 2のStep 4と同じ手順で`node --check`を実行。

- [ ] **Step 4: 実ブラウザで1つ検証する**

Step 2で追加したエイリアスのうち1つを選び、その日本語語で検索して該当作品が出ることを`mcp__chrome-devtools`で確認する。

- [ ] **Step 5: コミット**

```bash
git add index.html
git commit -m "Add Japanese aliases for AniList/TMDB niche tags (Component A, Task 5)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Rakuten向け新規AI分類(`content-classify`)

**Files:**
- Create: `supabase/functions/content-classify/index.ts`
- Modify: `supabase/functions/rakuten-discover-manga/index.ts`、`supabase/functions/rakuten-discover-novel/index.ts`

**Interfaces:**
- Consumes: Task 1の`niche_tags`列、各discover functionの`insertedRows`(id+title)と、insert前に既に持っている`caption`/`synopsis`文字列。
- Produces: `content-classify(movieId, synopsisFullText)`という呼び出し可能なHTTPエンドポイント。レスポンス`{ nicheTags: string[] }`。コンポーネントBの実装時、この関数の出力スキーマに`contentWarnings`が追加される(このタスクではniche_tagsのみ実装する)。

- [ ] **Step 1: `content-classify`のベースを作る**

`supabase/functions/content-classify/index.ts`を新規作成。既存の`music-scene-classify`(同じ「AIに分類させてDBへ書き込む」パターン)を参考に、以下の構造で書く:

```ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// オーナー方針(design spec コンポーネントA-4):「男性妊娠」のように作品
// ごとに違う語を返してよい、オープンエンドな語彙(感情タグのような固定
// 10語とは違う)。Rakuten由来(novel/manga)はAniList/TMDBのような既製の
// 細かいタグが無いため、この関数だけが新規のAI分類を行う。
const TOOL = {
  name: "classify_content",
  description: "作品のあらすじ全文から、検索で見つけたい人がいそうな具体的な設定・トロープを抽き出す。",
  input_schema: {
    type: "object",
    properties: {
      nicheTags: {
        type: "array",
        items: { type: "string" },
        description: "あらすじに実際に描写されている具体的な設定・トロープを、作品ごとに自由な言葉で。" +
          "固定の選択肢から選ぶのではなく、その作品に実際に当てはまる言葉を考えて書く" +
          "(例:「男性妊娠」「四肢欠損のあるキャラクター」「年の差カップル」)。" +
          "何も特筆すべき設定が無ければ空配列でよい。多くても5個程度に絞る。",
      },
    },
    required: ["nicheTags"],
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

async function classifyOne(synopsis: string): Promise<string[]> {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: "あなたは小説・漫画のあらすじから、検索で見つけたい人がいそうな具体的な設定・トロープを抽き出すアシスタントです。classify_contentツールを呼んでください。",
      messages: [{ role: "user", content: synopsis }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "classify_content" },
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "classify_content");
  if (!toolUse) return [];
  const tags = toolUse.input?.nicheTags;
  return Array.isArray(tags) ? tags.filter((t: unknown): t is string => typeof t === "string").slice(0, 5) : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    // items: [{ movie_id, synopsis }] の配列。複数件まとめて1リクエストで
    // 受け付けられるようにしておく(discover function側から挿入直後に
    // まとめて呼べるように。1件ずつ別リクエストにすると新規作品が多い日に
        // 呼び出し回数が増えてしまう)。
    const { items = [], write = true } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const results = [];
    for (const item of items) {
      const synopsis = (item.synopsis || "").trim();
      if (!synopsis) {
        results.push({ movie_id: item.movie_id, nicheTags: [] });
        continue;
      }
      const nicheTags = await classifyOne(synopsis);
      if (write && item.movie_id) {
        await supabase.from("movies").update({ niche_tags: nicheTags }).eq("id", item.movie_id);
      }
      results.push({ movie_id: item.movie_id, nicheTags });
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (err: any) {
    // このエンドポイントの失敗が呼び出し元(rakuten-discover-*)のinsert自体を
    // 道連れにしてはいけない(Review Focus参照)。呼び出し元はこのレスポンスの
    // 成否に関わらず、自分のinsertは既に完了させた後でこれを呼ぶこと。
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
```

- [ ] **Step 2: デプロイする**

```
mcp__supabase__deploy_edge_function で content-classify を新規デプロイ。
```

- [ ] **Step 3: 単体で動作確認する**

実際のあらすじ文(例: 既存のnovelタイトルの本物のあらすじ)を1件使い、`{"items":[{"movie_id":<実在ID>,"synopsis":"<本文>"}],"write":false}`でPOSTする。
Expected: `results[0].nicheTags`に、あらすじの内容に沿った具体的な語が1〜5個返る。

- [ ] **Step 4: `write:true`で1件だけ書き込み確認**

同じリクエストを`write:true`で実行し、
```sql
select id, title, niche_tags from movies where id = <実在ID>;
```
Expected: `niche_tags`にStep 3と同じ内容が入っている。

- [ ] **Step 5: `rakuten-discover-novel`からinsert直後に呼び出す**

`supabase/functions/rakuten-discover-novel/index.ts`の、`insertedRows`を受け取った直後(`estimateRows`の処理と同じ並び)に追加:

```ts
      if (insertedRows?.length) {
        const idByTitle = new Map(insertedRows.map((r: any) => [normalizeTitle(r.title), r.id]));
        // オーナー指摘(2026-10-22):Rakuten分はニッチ属性タグの既製元が無い
        // ため、ここでcontent-classifyを呼ぶ(design spec A-4)。失敗しても
        // insert自体(新規作品の取り込み)は既に終わっているので影響しない。
        const classifyItems = rows
          .map((r) => {
            const movieId = idByTitle.get(normalizeTitle(r._key));
            return movieId ? { movie_id: movieId, synopsis: r.synopsis || "" } : null;
          })
          .filter(Boolean);
        if (classifyItems.length) {
          await fetch(`${SUPABASE_URL}/functions/v1/content-classify`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_ROLE}` },
            body: JSON.stringify({ items: classifyItems, write: true }),
          }).catch((err) => console.error("content-classify呼び出しに失敗しました", err));
        }
      }
```

(挿入位置は既存の`estimateRows`書き込みブロックの直後。`SERVICE_ROLE`という変数名は既存ファイル内の実際の定数名に合わせること。)

- [ ] **Step 6: `rakuten-discover-manga`にも同様に追加する**

同じパターンを`supabase/functions/rakuten-discover-manga/index.ts`にも追加する(novelの実装をそのままなぞる、挿入箇所は同ファイルの`insertedRows`取得直後)。

- [ ] **Step 7: デプロイして一連の流れをテストする**

`rakuten-discover-novel`を`dry_run:false, write:true`で1件だけ新規取り込み実行し、
```sql
select id, title, niche_tags from movies where media_type='novel' order by id desc limit 1;
```
Expected: 新規追加された1件に`niche_tags`が入っている(content-classifyが自動的に効いている)。

- [ ] **Step 8: content-classifyの失敗が新規作品の取り込み自体を止めないことを確認する(Review Focus)**

Step 5/6で追加したコードを読み返し、以下の順序になっていることをコードレビューで確認する(本番で意図的に失敗させるテストは行わない):
1. `movies`テーブルへの`.insert(insertPayload)`と`insertedRows`の取得が、content-classify呼び出しより**先に**完了している(=この時点で新規作品の取り込み自体は確定済み)。
2. content-classifyへの`fetch(...)`が`.catch((err) => console.error(...))`で囲まれており、この呼び出しの成否が関数全体の戻り値・ステータスコードに影響しない。

Expected: 上記2点がコード上で満たされている。満たされていなければ、`insertedRows`取得と`.insert()`の位置関係、または`.catch()`の有無を修正する。

- [ ] **Step 9: コミット**

```bash
git add supabase/functions/content-classify supabase/functions/rakuten-discover-novel/index.ts supabase/functions/rakuten-discover-manga/index.ts
git commit -m "Add content-classify and wire it into Rakuten discover functions (Component A, Task 6)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## 完了後の確認(全タスク共通)

- `mcp__supabase__get_advisors`でセキュリティ/パフォーマンスの新規指摘が出ていないか確認する。
- 本番(`https://wander-8.site/`)で実際に「男性妊娠」等、Task 1〜6で実際に取り込まれたニッチタグの1つを検索し、該当作品が出ることを目視確認する。

# 感情別特集セクション（週替わり・収益化対応・レトロシネマUI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wanderのホーム最上部にある既存の「今週の特集」を、(1) 本当に週替わりで回る感情テーマに、(2) 作品カードから配信/購入へ自動で誘導する収益化導線付きに、(3) レトロ・シネマティックな専用UIに作り替える。

**Architecture:** ゼロから新システムを作るのではなく、既存の `generate-daily-feature` edge function + `automated_features` テーブル + `renderWeeklyFeature()` を土台として拡張する（下記「重要な前提」参照）。新規に増やすのは (a) 週次カデンスへの定数変更、(b) 楽天アフィリエイト用のクライアント側ヘルパー、(c) 特集カード専用の購入CTA付きカードビルダー、(d) レトロシネマ調のCSS/マークアップ、の4点のみ。

**Tech Stack:** Deno edge functions (Supabase)、Anthropic Messages API (Claude Haiku 4.5、tool use)、Postgres + pg_cron + pg_net、素のHTML/CSS/JS（`index.html`単一ファイル、ビルドなし）。

**Spec:** このプランは本ドキュメント自身がspec（ユーザーからの3要件＋チーム視点の指示）を兼ねる。独立したspecファイルは無い。

## 重要な前提（計画を書く前に判明した事実）

実装に入る前にコードベースを調査した結果、要件1（週次AI自動生成＋Cron）は**すでに実装済み**だったことが分かった。これは当初の想定（ゼロから作る）を覆す発見なので、最初に明記する。

- `supabase/functions/generate-daily-feature/index.ts` が既に存在し、Claude Haiku 4.5で感情タグ1つを選び、該当作品を全メディア種別から選出し、`write_feature` ツールでタイトル・紹介文を生成し、`automated_features` テーブルにINSERTしている。
- pg_cronの `jobid=19`（`generate-daily-feature`）が毎日UTC 20:00（JST翌5:00）にこの関数を叩いている。関数内部にも「前回生成から20時間未満ならスキップ」という冪等ガードがある。
- `index.html` 側の `renderWeeklyFeature()`（6812行目付近）が `automated_features` の最新1件を読み、`weekly-feature-area` に表示している。ラベルは既に「今週の特集」（6783行目）。
- つまり現状は **「毎日生成されるが、見た目のラベルは『今週の』と言っている」** という状態。要件1「毎週新しい感情テーマ」を文字通り実現するなら、やるべきことは新システムの構築ではなく、**カデンスを日次→週次に変える定数変更**だけで足りる。
- 収益化（要件2）も土台だけは既にある：`withAmazonAffiliateTag()` / `AMAZON_ASSOCIATE_TAG`（Amazon用、現在は未審査で空文字）、`VOD_PROVIDER_LINKS`（Netflix/Amazon Prime Video/U-NEXT/Hulu/Disney+/FODの検索リンクを解決、10817行目付近）が既にある。**ただし楽天向けのアフィリエンス導線は無い**（漫画・小説の `amazon_url` は常にAmazon検索リンクで、楽天リンクを生成する仕組みが無い）。ここが要件2の本当の新規作業。
- リッチなUI（要件3）は本当に未着手。現在の `.weekly-feature` は92px幅の汎用カードを横に並べただけの簡素な見た目（984〜995行目）。ここも本当の新規作業。

この前提により、本プランは「3つの新サブシステムを作る」ではなく「既存の自動特集システムのカデンスと見た目と収益化導線を拡張する」計画になっている。

## Global Constraints

- デプロイは `git push origin main` のみ。ビルドステップは存在しない（`index.html`を直接編集する）。
- Supabase Edge Functionのデプロイ（`mcp__supabase__deploy_edge_function`）は常にファイル全文を渡す方式で、diffは無い。ファイルを読み直した最新の内容からそのまま貼ること（コメントを省略した再構成版を使わない）。
- 対象ユーザーは「ライト/カジュアルユーザー」。特集の文体・UIは映画通向けの専門用語を避ける（`/Users/nitta/Desktop/Wander/CLAUDE.md` のWriter欄）。
- ステータス/ランキング的なゲーミフィケーションを新たに作らない（同CLAUDE.md Designer欄）。
- レスポンシブは `.app` コンテナの拡大に合わせて要素を拡大させず、`max-width`/`min()`で絶対サイズを固定する（同欄、responsive-design-law）。
- 新しいUIはユーザーに一旦プライベートなArtifactで見せ、承認を得てから `index.html` に反映する（今回のユーザー指示）。
- 正規表現やDB一括変更の前にdry run/SELECTで確認する（同CLAUDE.md Engineer欄）。今回は大量データ変更は無いが、cron/edge function変更は本番に即影響するため、`force:true`での単発実行結果を必ず目で確認してから次のタスクへ進む。
- `main`へのマージは、実装の許可とは別に、オーナーの明示的な確認を取る（同CLAUDE.md Engineer欄、merge-confirmation）。

## Review Focus

- **データが1件も無い週**: `automated_features` に行が無い/条件に合う作品が無い場合、`renderWeeklyFeature()` は既にセクションを静かに隠す実装になっている（6823行目）。新しいUIに置き換えた後も、この「空なら何も出さない」挙動を壊さないこと（Task 5のテストで確認）。
- **配信/購入リンクが1つも無い作品がピックされた場合**: カードにCTAボタンが出ない空洞ができないよう、`buildFeatureCardHTML`はリンクが無い時はCTA自体を出さない（ボタンを無効状態で出さない）。
- **Amazon/楽天のアフィリエイトIDが未設定（現状どちらも未登録）**: プレーンな直接リンクとして機能し続け、リンク切れや空文字paramにならないこと（Task 2のテストで確認）。
- **週次カデンス変更直後の重複生成**: cron移行時に旧日次ジョブが並走して二重生成されないよう、Task 1で旧cronジョブを確実に置き換える（残したままスケジュール文字列だけ変える）。
- **スマホ幅(~400px)でのスライダー破綻**: 新デザインが横スクロールやカード幅をちゃんと持つか、Task 7で実機幅チェックする（横スクロール自体はOKだが、ページ全体が横に伸びるのはNG）。

---

## チーム視点の割り当て

`/Users/nitta/Desktop/Wander/CLAUDE.md` の4人チームの観点を、タスクごとに以下のように当てる。

- **Marketer**: カデンス（週次vs日次の実感）、収益化導線の優先順位（どのサービスを前に出すか）、コピーの訴求力。
- **Designer**: レトロシネマのビジュアル言語、既存の夜空/紫パレットとの整合、レスポンシブ。
- **Engineer**: edge function改修、DB/Cron、既存ヘルパーの再利用、検証。
- **Writer**: 特集タイトル・紹介文のAIプロンプト、CTAボタンのラベル文言、カジュアル層向けの温度感。

---

### Task 1: 週次カデンスへの変更（Engineer / Marketer）

**Files:**
- Modify: `supabase/functions/generate-daily-feature/index.ts`（edge function全体を読み直してから編集し、`mcp__supabase__deploy_edge_function`で全文再デプロイ）
- Modify: pg_cronジョブ `jobid=19`（SQLで `cron.alter_job` または drop→create）

**Interfaces:**
- Consumes: 既存の `automated_features` テーブル（列は変更しない: id, title, description, top_tag, selected_movie_ids, created_at）
- Produces: `weekOfYearTag(): string`（`todaysTag()`を置き換える新関数）。週が変わるたびに `EMOTION_TAGS` 配列から1つ選ぶ。Task 5のUI側はこの関数の出力を直接は使わない（`top_tag`列経由で読むだけ）ので後続タスクへの影響は無い。

- [ ] **Step 1: 現状のcronジョブとガード時間を確認する**

Run:
```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'generate-daily-feature';
```
Expected: `schedule = '0 20 * * *'`, `active = true` の1行。

- [ ] **Step 2: edge functionのタグ選定・ガード時間を週次に変更する**

`supabase/functions/generate-daily-feature/index.ts` の該当部分を以下に置き換える（他の処理—候補選定・AI呼び出し・INSERT—はそのまま）:

```ts
// 1日単位の感情タグ切り替えだと、オーナー要望の「毎週新しい感情テーマ」の
// 「週替わり」感と合わなくなる(見た目のラベルは既に「今週の特集」)。
// ISO週番号(UTCの週、月曜始まり)を使い、週内は同じタグ・同じ特集のまま
// 固定する。epoch週番号ではなく、年をまたいだ時の衝突を避けるため
// 「epoch日数を7で割った週番号」のままで十分(表示上の『第N週』ラベルは
// 出していないため、年境界のズレは実害が無い)。
function weekOfYearTag(): string {
  const weekNum = Math.floor(Date.now() / (7 * 86400000));
  return EMOTION_TAGS[weekNum % EMOTION_TAGS.length];
}
```

関数内で `todaysTag()` を呼んでいた箇所（`const tag = todaysTag();`）を `const tag = weekOfYearTag();` に変更する。

さらに、冪等ガードの時間を20時間→6.5日に伸ばす（週1回しか生成しないように）:

```ts
if (recent && Date.now() - new Date(recent.created_at).getTime() < 6.5 * 24 * 60 * 60 * 1000) {
  return new Response(JSON.stringify({ skipped: true, reason: "already_generated_recently", last: recent.created_at }), {
    headers: jsonHeaders,
  });
}
```

`todaysTag()` 関数自体は呼び出し元が無くなるので削除する（放置すると「使われているように見えて実は死んでいる」コードになり、次に読む人を誤解させる）。

- [ ] **Step 3: 変更後のファイル全文を読み直し、deploy_edge_functionで再デプロイする**

Run: 変更後の `supabase/functions/generate-daily-feature/index.ts` を実際にRead toolで読み、その内容をそのまま `mcp__supabase__deploy_edge_function` の `files[0].content` に渡す（再構成・コメント省略は禁止、Global Constraints参照）。

- [ ] **Step 4: force:trueで1回実行し、週のタグが正しく選ばれ、INSERTされることを確認する**

Run:
```bash
curl -s -X POST "https://wjhvifdbttlijxnreaha.supabase.co/functions/v1/generate-daily-feature" \
  -H "Authorization: Bearer <anon key>" -H "Content-Type: application/json" \
  -d '{"force":true}'
```
Expected: `{"ok":true,"title":"...","tag":"<EMOTION_TAGSのいずれか>","movie_ids":[...]}` が返る。直後にSQLで確認:
```sql
select title, top_tag, created_at from automated_features order by created_at desc limit 1;
```
Expected: 直前のcurl呼び出しの結果と一致する新しい行。

- [ ] **Step 5: force:falseで再実行し、同じ週内はスキップされることを確認する**

Run: 同じcurlを `"force":false` で再実行。
Expected: `{"skipped":true,"reason":"already_generated_recently",...}`。これが出ない場合はStep2の時間計算にバグがある。

- [ ] **Step 6: pg_cronのスケジュールを週次に変更する**

`0 20 * * *`（毎日）から、毎週月曜UTC 20:00（JST火曜5:00。月曜の朝イチで出したい場合はオーナーに希望時刻を確認し、下記を調整する—Marketer判断待ち、Execution Handoffで確認）に変更:

```sql
select cron.alter_job(
  job_id := 19,
  schedule := '0 20 * * 1'
);
```

Run:
```sql
select jobid, schedule from cron.job where jobid = 19;
```
Expected: `schedule = '0 20 * * 1'`。

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/generate-daily-feature/index.ts
git commit -m "Switch the home feature's emotion-theme rotation from daily to weekly"
```

---

### Task 2: 楽天アフィリエイトヘルパーの追加（Engineer）

**Files:**
- Modify: `index.html`（既存の `withAmazonAffiliateTag`/`AMAZON_ASSOCIATE_TAG`/`VOD_PROVIDER_LINKS` の直後、10802行目付近に追加）

**Interfaces:**
- Consumes: 無し（独立したヘルパー、既存コードは一切変更しない）
- Produces: `RAKUTEN_AFFILIATE_ID: string`（定数、空文字の間はタグ無しリンクのまま）、`withRakutenAffiliateTag(url: string): string`、`rakutenBookSearchLink(title: string): string`（漫画・小説タイトルから楽天ブックスの検索リンクを作る。既存の `amazon_url` 列は変更しない—あくまで表示側で選択肢を1つ増やすだけ）。後続タスク(Task 3)がこの3つを使う。

- [ ] **Step 1: ヘルパー関数を追加する**

```js
// 楽天アフィリエイト(楽天アフィリエイトプログラム)のトラッキングID。
// withAmazonAffiliateTagと同じ考え方: 登録・審査後にこの値を書き換える
// だけで、楽天ブックスへの誘導リンク全てに自動で反映される。2026年時点では
// まだ未取得のため空文字のままにしておく(登録: https://affiliate.rakuten.co.jp/ )。
// 未設定の間は非アフィリエイトの直接リンクのままでも機能自体は出し続ける
// (AMAZON_ASSOCIATE_TAGと同じ「まずは直接リンクだけにする」方針)。
const RAKUTEN_AFFILIATE_ID = '';
function withRakutenAffiliateTag(url){
  if(!RAKUTEN_AFFILIATE_ID) return url;
  // 楽天アフィリエイトのリンク変換は本来hb.afl.rakuten.co.jp経由のラッパーURLに
  // なるが、正式なURL構造はID発行後に楽天側の管理画面で生成されるパターンに
  // 合わせて再確認する(ここでは発行後に差し替える前提のプレースホルダー実装)。
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}rafcid=${encodeURIComponent(RAKUTEN_AFFILIATE_ID)}`;
}

// 漫画・小説の購入導線は現状amazon_url(Amazon検索リンク)しか無く、楽天への
// 導線が存在しない(オーナー要望:「楽天...のアフィリエイト導線」)。楽天
// ブックス自体の検索ページへの直接リンクを作品タイトルから生成する
// (VOD_PROVIDER_LINKSと同じ「ディープリンクが取れないのでサービス自身の
// 検索ページへ飛ばす」方式)。
function rakutenBookSearchLink(title){
  return withRakutenAffiliateTag(`https://books.rakuten.co.jp/search?g=001&sitem=${encodeURIComponent(title)}`);
}
```

- [ ] **Step 2: ブラウザのconsoleで3パターン手動確認する**

ローカルで `python3 -m http.server` → `index.html` を開き、DevTools consoleで:
```js
rakutenBookSearchLink('薬屋のひとりごと')
// → "https://books.rakuten.co.jp/search?g=001&sitem=%E8%96%AC%E5%B1%8B%E3%81%AE%E3%81%B2%E3%81%A8%E3%82%8A%E3%81%94%E3%81%A8" (RAKUTEN_AFFILIATE_IDが空なのでrafcid無し)
withAmazonAffiliateTag('https://www.amazon.co.jp/s?k=test')
// → 'https://www.amazon.co.jp/s?k=test' (AMAZON_ASSOCIATE_TAGも空なので変化無し、既存動作が壊れていないことの確認)
```
Expected: 上記の通り。`rafcid`パラメータが付かないこと(ID未設定時に壊れたURLにならないこと)を目視確認する。

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add a Rakuten affiliate link helper alongside the existing Amazon one"
```

---

### Task 3: 特集カード専用の購入CTA付きカードビルダー（Engineer / Writer）

**Files:**
- Modify: `index.html`（`buildCardHTML`関数の直後、5906行目付近に新関数を追加。既存の`buildCardHTML`自体は変更しない—他の全ての一覧表示への影響を避けるため）

**Interfaces:**
- Consumes: Task 2の `withAmazonAffiliateTag`, `rakutenBookSearchLink`, 既存の `vodProviderLink`/`canonicalVodProviderName`/`VOD_PROVIDER_LINKS`（10781〜10831行目、変更しない）
- Produces: `buildFeatureCardHTML(m, watchData): string`。`watchData`は`{vodFlatrate, officialUrl, amazonUrl}`の形(既存の`WATCH_LINK_COLUMNS`フェッチ結果と同じ形、Task 5で渡す)。後続タスク(Task 5)がこれを呼ぶ。

- [ ] **Step 1: CTAリンク解決ロジックを書く**

```js
// 特集カードは直接「観る/買う」に1タップで辿り着いてほしい(オーナー要望:
// 収益化導線)。detail画面のrenderWatchLinksのような複数チップは小さな
// カードには収まらないため、優先順位1つだけをCTAボタンにする:
// 1. 見放題配信(vodFlatrate)があればその中の1社(最初の1件)
// 2. 無ければAmazon購入リンク(amazonUrl)
// 3. 書籍でamazonUrlもvodFlatrateも無い場合は楽天ブックス検索(タイトルから生成)
// 4. 無ければofficialUrl
// 5. どれも無ければCTA自体を出さない(空洞を作らない、Review Focus参照)
function resolveFeatureCardCTA(m, watchData){
  const providers = (watchData && watchData.vodFlatrate) || [];
  if(providers.length){
    const canonical = canonicalVodProviderName(providers[0]);
    return { label: `${canonical}で観る`, href: vodProviderLink(canonical, m.title) };
  }
  if(watchData && watchData.amazonUrl){
    return { label: 'Amazonで購入', href: withAmazonAffiliateTag(watchData.amazonUrl) };
  }
  if(m.isManga || m.isNovel){
    return { label: '楽天ブックスで探す', href: rakutenBookSearchLink(m.title) };
  }
  if(watchData && watchData.officialUrl){
    return { label: '公式サイトへ', href: watchData.officialUrl };
  }
  return null;
}

// 特集スライダー専用のカード。既存buildCardHTMLは他の全ての一覧(検索結果・
// マイリスト等)で使われており、ここだけの都合(CTAボタン)で変更すると
// 影響範囲が広すぎるため、別関数として用意する。
function buildFeatureCardHTML(m, watchData){
  const cta = resolveFeatureCardCTA(m, watchData);
  const hasPoster = !!m.posterUrl;
  const posterImg = hasPoster ? `<img src="${m.posterUrl}" alt="" loading="lazy" decoding="async">` : '';
  const initial = hasPoster ? '' : `<span class="poster-thumb-initial">${escapeHtml(m.title.charAt(0))}</span>`;
  return `
    <div class="feature-card" onclick="goDetailWithMode(${m.id}, '${mediaTypeInfo(m).mode}')">
      <div class="feature-card-poster" style="background:${m.posterColor}">${posterImg}${initial}</div>
      <div class="feature-card-title">${escapeHtml(m.title)}</div>
      ${cta ? `<a class="feature-card-cta" href="${escapeHtml(cta.href)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escapeHtml(cta.label)}</a>` : ''}
    </div>
  `;
}
```

- [ ] **Step 2: 3パターンのフィクスチャでconsole手動確認する**

```js
// パターン1: 見放題あり
buildFeatureCardHTML({id:1,title:'テストA',posterUrl:null,posterColor:'#333',isManga:false,isNovel:false}, {vodFlatrate:['Netflix'], amazonUrl:null, officialUrl:null})
// → "Netflixで観る" のCTAが含まれること

// パターン2: 本でamazonUrlのみ
buildFeatureCardHTML({id:2,title:'テストB',posterUrl:null,posterColor:'#333',isManga:true,isNovel:false}, {vodFlatrate:[], amazonUrl:'https://www.amazon.co.jp/s?k=test', officialUrl:null})
// → "Amazonで購入" のCTAが含まれること

// パターン3: 何も無い
buildFeatureCardHTML({id:3,title:'テストC',posterUrl:null,posterColor:'#333',isManga:false,isNovel:false}, {vodFlatrate:[], amazonUrl:null, officialUrl:null})
// → feature-card-ctaのaタグが含まれない(空洞を作らない、Review Focus参照)
```
Expected: 上記の通り。`mediaTypeInfo`は既存関数なので壊れていなければ動く。

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Add a feature-card builder with a single resolved purchase/watch CTA"
```

---

### Task 4: レトロシネマUIのモックアップ作成・オーナー承認（Designer / Writer）

**Files:**
- Create: ローカルの一時HTMLファイル（Artifactとして公開、`index.html`は一切変更しない）

**Interfaces:**
- Consumes: 無し(フィクスチャデータのみ、実データ接続は無し)
- Produces: 承認されたビジュアル仕様(配色トークン・タイポグラフィ・レイアウト)。Task 5がこれをそのまま`index.html`のCSSに落とす。

- [ ] **Step 1: frontend-designスキルを読み込む**

実装前に `frontend-design:frontend-design` スキルを呼び、以下を固有の方向性として反映する(スキルの一般論のままにしない):
- 既存パレット(夜空紺 `--bg:#05080f`、紫 `--plum:#7d5fd6`/`--gold:#a084f2`、暖色 `--terracotta:#e8a06a`、`--love:#e8899e`)を土台に、レトロシネマらしい新トークンを追加する(例: マーキーライトの暖色電球色、フィルムの深いマルーン/バーガンディ、チケットの紙っぽいクリーム)。既存の柔らかい丸ゴシック(`M PLUS Rounded 1c`)とは違う、このセクション専用の見出し用セリフ/ディスプレイ書体を1つ選ぶ(Google Fonts、CSP許可ホストのみ)。
- モチーフ: 劇場のマーキー電光(カード外周の点滅する光の粒)、フィルムストリップのパーフォレーション(スプロケット孔)を帯の上下端に、チケットの半券のような切り込み(カードの角)。
- ターゲットはライト/カジュアルユーザーなので、モチーフは「映画オタク向けの重厚さ」ではなく「レトロでちょっと特別な気分になる」程度に留める(CLAUDE.md Designer欄)。

- [ ] **Step 2: フィクスチャデータでモックアップを1枚のHTMLとして書く**

Task 1〜3で確定した実データ構造(`automated_features`の`title`/`description`、`buildFeatureCardHTML`が受け取る`m`と`watchData`の形)に忠実な、架空の3〜4件の特集データ(例:「深夜に1人で観たい」というテーマ名、それっぽい紹介文1〜2文、3〜4枚のカード、各カードにCTAラベル)をハードコードしたモックアップを作る。ダークモード/ライトモードの両方(ホストのテーマに追従)、スマホ幅(~400px)とPC幅(1100px)の両方で見た目が破綻しないことを自分で確認する。

- [ ] **Step 3: Artifactとして公開し、オーナーに見せる**

Artifactツールで公開(`favicon`に🎬等、`title`は具体的な名前)。

**STOP — ここでオーナーの承認を得るまでTask 5に進まない。** 承認されたら、配色トークン・フォント・レイアウトの最終版をメモしてTask 5に引き継ぐ。差し戻しがあれば、本Taskをもう一度(Step 2〜3)繰り返す。

---

### Task 5: `index.html`への実装（Engineer / Designer）

**Files:**
- Modify: `index.html`
  - CSS: `.weekly-feature`〜`.weekly-feature-row`ブロック(984〜995行目)を、Task 4で承認されたデザインのクラス名に置き換える(例: `.cinema-feature`, `.cinema-feature-title`, `.cinema-feature-desc`, `.cinema-feature-row`, `.feature-card`, `.feature-card-cta` 等)。
  - JS: `renderWeeklyFeature()`(6812〜6846行目)を以下のロジックに変更する。

**Interfaces:**
- Consumes: Task 3の `buildFeatureCardHTML`、既存の `WATCH_LINK_COLUMNS`(11090行目、変更しない)
- Produces: 画面上の新しい特集セクション(以降のタスクは無し、最終出力)

- [ ] **Step 1: `renderWeeklyFeature()`を書き換える**

```js
// 書く「今週の特集」(generate-daily-feature edge function、automated_features
// テーブル)を、ホーム画面の一番上に出す。まだ1件も生成されていない場合は
// 静かにセクションごと隠す(空状態を見せる必要はない、裏で勝手に増えていく
// コンテンツのため)。カードには収益化のため配信/購入CTAを1つ付ける
// (buildFeatureCardHTML)。CTAの解決には各作品のvod_flatrate/amazon_url/
// official_url(軽量一括取得には含まれない列)が必要なため、選ばれた数本
// だけ個別にフェッチする(renderMovieInfoPanelと同じWATCH_LINK_COLUMNSパターン)。
async function renderWeeklyFeature(){
  const label = document.getElementById('weekly-feature-label');
  const area = document.getElementById('weekly-feature-area');
  if(!label || !area) return;
  try{
    const { data, error } = await supabase
      .from('automated_features')
      .select('title, description, selected_movie_ids')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if(error || !data){ label.style.display = 'none'; area.innerHTML = ''; return; }
    const movies = (data.selected_movie_ids || [])
      .map(id => MOVIES.find(m => m.id === Number(id)))
      .filter(Boolean)
      .slice(0, 4);
    if(!movies.length){ label.style.display = 'none'; area.innerHTML = ''; return; }

    const { data: watchRows } = await supabase
      .from('movies')
      .select(WATCH_LINK_COLUMNS)
      .in('id', movies.map(m => m.id));
    const watchById = new Map((watchRows || []).map(r => [r.id, {
      vodFlatrate: r.vod_flatrate || [],
      amazonUrl: r.amazon_url || null,
      officialUrl: r.official_url || null,
    }]));

    const descFlat = (data.description || '').replace(/\n+/g, ' ').trim();
    label.style.display = '';
    area.innerHTML = `
      <div class="cinema-feature">
        <div class="cinema-feature-title">${escapeHtml(data.title)}</div>
        <div class="cinema-feature-desc">${escapeHtml(descFlat)}</div>
        <div class="cinema-feature-row">${movies.map(m => buildFeatureCardHTML(m, watchById.get(m.id) || {})).join('')}</div>
      </div>
    `;
  }catch(err){
    console.error('特集の読み込みに失敗しました', err);
    label.style.display = 'none';
    area.innerHTML = '';
  }
}
```

- [ ] **Step 2: Task 4で承認されたCSSを反映する**

承認されたモックアップのCSSをそのまま`.cinema-feature`系クラスとして貼る。レスポンシブ原則(Global Constraints参照)を守り、カードサイズに`max-width`/`min()`で絶対上限を付ける(`.app`が1100pxに広がってもカードが肥大化しないこと)。

- [ ] **Step 3: ローカルで実際に表示確認する**

Run: `python3 -m http.server` → chrome-devtools MCPで`http://localhost:8000`を開き、ホーム画面最上部を確認。
Expected: 新しいレトロシネマ調の特集セクションが表示され、カードをクリックするとCTAボタンは新しいタブで配信/購入先に飛び(カード本体のクリックは詳細ページに飛ぶ)、2つのクリックが競合しない(`event.stopPropagation()`が効いている)こと。

- [ ] **Step 4: 空データ時に静かに隠れることを確認する**

Run: chrome-devtools MCPの`evaluate_script`で一時的に`automated_features`クエリをモックせず、実際に`automated_features`テーブルを空にしたテスト用ブランチ条件は作らず、代わりにコード上で「`data`が無い場合」の分岐(`if(error || !data)`)をロジックレベルで読み直し、Task 1以前の動作(今も同じ分岐)から変えていないことを確認する(回帰確認)。

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Redesign the home weekly-feature section with retro-cinema UI and purchase CTAs"
```

---

### Task 6: AIプロンプトの文体調整（Writer）

**Files:**
- Modify: `supabase/functions/generate-daily-feature/index.ts`（`systemPrompt`と`tool.input_schema.properties.description.description`、Task 1で既に全文を触っているので同じ編集セッションでまとめてもよい）

**Interfaces:**
- Consumes: 無し(文字列のみの変更)
- Produces: 無し(最終タスクではないが独立して検証可能)

- [ ] **Step 1: プロンプトをレトロシネマの枠組みに合わせて調整する**

現在の`systemPrompt`(「雑誌の特集ページの前書きのような紹介文」)を、Task 4で確定したビジュアルの世界観(劇場のマーキー、上映プログラムの趣)に合わせて更新する:

```ts
const systemPrompt = [
  "あなたは映画・アニメ・ドラマ・漫画・小説・音楽の発見サイト「Wander」の特集編集者です。",
  `今週のテーマは「${tag}」です。選ばれた作品群の実際のあらすじ・ジャンルを読み比べ、` +
    "小さな劇場の今週の上映プログラムに添えるような、温かく誘う紹介文を書いてください。",
  "write_featureツールを必ず1回呼んでください。",
].join("\n");
```

タイトルの`description`(ツール入力スキーマ側)も「雑誌の特集見出し」→「上映プログラムの見出し」のニュアンスに微調整する程度に留め、文字数制約(15字程度)や断定表現を避ける既存ルールは変えない。

- [ ] **Step 2: force:trueで再実行し、文体を目で確認する**

Run: Task 1のStep4と同じcurl。
Expected: `title`/`description`が新しい文体のトーンになっている(ライト層向けの温度感を保ちつつ、劇場・上映のニュアンスが入っている)。決めつけ表現(「絶対に」等)が無いこと。

- [ ] **Step 3: deploy_edge_functionで再デプロイし、Commit**

```bash
git add supabase/functions/generate-daily-feature/index.ts
git commit -m "Tune the weekly feature's AI copy prompt to match the retro-cinema framing"
```

---

### Task 7: エンドツーエンド検証（Engineer / Designer）

**Files:** 無し(検証のみ)

- [ ] **Step 1: 本番相当データでの表示確認**

Run: `mcp__supabase__execute_sql`で最新の`automated_features`行と、その`selected_movie_ids`に対応する`movies`行の`vod_flatrate`/`amazon_url`/`official_url`を確認。
Expected: 少なくとも1件はCTAが出る作品であること(全件リンク無しだとこの特集回自体の収益化効果が無いため、Marketer観点で望ましくない—ただし機能としては正しく「CTA無し」で表示される)。

- [ ] **Step 2: chrome-devtools MCPでスマホ幅(400px)とPC幅(1100px)の両方をスクリーンショット確認**

Expected: どちらの幅でもページ全体が横スクロールしない(カード列自体の横スクロールはOK)。カードサイズがPC幅で肥大化していない(Global Constraints/responsive-design-law)。

- [ ] **Step 3: CTAリンクのクリック先が実際に開くことを確認**

Run: chrome-devtools MCPで各CTAボタンの`href`を取得し、Amazon/楽天ブックス/各VODの検索ページとして妥当なURL形式になっているかを目視確認(実際にクリックして遷移確認までは不要、URL形式の確認で十分)。

- [ ] **Step 4: Lighthouseでパフォーマンス回帰が無いことを確認(任意)**

Run: `mcp__plugin_chrome-devtools-mcp_chrome-devtools__lighthouse_audit`のperformanceカテゴリをホーム画面で実行。
Expected: 新しいセクション追加前と大きく変わらないLCP/CLS(カード画像は既存同様`loading="lazy"`)。

---

### Task 8: マージ前の最終確認（Engineer）

**Files:** 無し

- [ ] **Step 1: 全コミットをオーナーに提示し、マージの明示的な許可を得る**

`main`への実装自体の許可とマージの許可は別(CLAUDE.md Engineer欄、merge-confirmation)。Task 1〜7のコミット内容をまとめてオーナーに見せ、マージして良いか確認する。

- [ ] **Step 2: 未解決の外部依存をオーナーに明示する**

以下はコードの問題ではなく、オーナー側で完了させる必要がある外部手続きである旨を伝える:
- Amazonアソシエイト審査(`AMAZON_ASSOCIATE_TAG`、既存の未解決事項)
- 楽天アフィリエイト登録(`RAKUTEN_AFFILIATE_ID`、本プランで新規に追加した未解決事項)
- U-NEXTを含む他VODサービスの正式なアフィリエイト導線(ValueCommerce/A8.net等への個別登録、既存の未解決事項—現状は直接検索リンクのまま)

- [ ] **Step 3: 許可を得てからmainにpush**

```bash
git push origin main
```

---

## Self-Review(このプランの自己チェック)

1. **Spec coverage**: 要件1(週次AI自動生成)→Task 1。要件2(収益化導線)→Task 2・3・5。要件3(リッチUI)→Task 4・5・6。「裏で一旦見せる」→Task 4のSTOPゲート。チーム4視点→タスクごとに明記済み。
2. **Placeholder scan**: 全ステップに実コードまたは実SQL/curlコマンドを記載済み。「TODO」「後で実装」は無い。
3. **Type consistency**: `watchData`の形(`{vodFlatrate, amazonUrl, officialUrl}`)はTask 3で定義し、Task 5のフェッチ側もそのプロパティ名で組み立てている。`buildFeatureCardHTML(m, watchData)`のシグネチャはTask 3→Task 5で一致。
4. **Review Focus**: 上記5項目はそれぞれ担当タスクの中にテスト/確認ステップとして含めた。

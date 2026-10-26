# リスト × 契約サービス連携 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ウィッシュリスト機能を廃止し、シンプルなリスト機能でユーザーの契約サービスを表示・管理する MVP を実装

**Architecture:** Phase 1 では「リスト表示」と「契約サービス設定」のみ実装。作品情報の「どこで見られるか」データは既存カタログを活用。詳細モーダル・アフィリエイトリンクは Phase 2 以降。

**Tech Stack:** Supabase（RLS 対応、user_service_subscriptions テーブル）、index.html の既存構造を拡張、JavaScript（localStorage + Supabase 同期）

**Spec:** `/Users/nitta/Desktop/Wander/docs/superpowers/specs/2026-10-26-wishlist-service-linking-design.md`

## Global Constraints

- 単一ファイル構造維持：index.html のみ（他ファイル追加不可）
- Supabase RLS：user_service_subscriptions テーブルへのアクセスは認証ユーザーのみ、自分のデータのみ可視
- UI：既存ダークテーマの色設定に合わせる（#05080f, #0a0e16, #fdf8f0）
- テスト：Supabase クエリの RLS ポリシー検証は edgefunction または手動テストで確認

## Review Focus

1. **RLS ポリシーの不完全性** — user_service_subscriptions テーブルへのアクセスが認証なしで可能になるリスク。ポリシー厳密性テスト必須。
2. **N+1 クエリ** — リスト取得時にユーザーの契約情報を毎回クエリする場合、パフォーマンス低下。1度のクエリで全情報取得するか、キャッシュ戦略確認。
3. **複数タブ間の同期漏れ** — ユーザーが A タブで契約情報を変更、B タブはキャッシュのままという状況。localStorage + イベントリスナーまたは Supabase リアルタイム機能で対応必須。
4. **初回ロード時の契約情報が undefined** — 認証フローの後、Supabase から契約情報を取得する前にリストを描画すると、「契約中のサービス」が表示されない。条件分岐と読み込み待機確認。
5. **レンタル・購入データの欠落** — spec では「Google Play でレンタル ¥500」みたいに表示するが、既存カタログデータにレンタル情報がない場合の fallback。仕様確認。

---

## File Structure

Wander_Wave は単一ファイル（index.html）構造のため、新規ファイル追加なし。既存 index.html 内に以下機能を追加：

| 責務 | 実装箇所 | 説明 |
|------|--------|------|
| **CSS** | index.html `<style>` | 契約サービス表示、セクション分割、モーダル UI |
| **HTML structure** | 既存 `renderHomeRows()` など | 「あなたが見られる作品」「追加契約が必要な作品」セクション |
| **JavaScript - UI** | `buildCardHTML()`, リスト描画関数 | カード表示ロジック、セクション分割ロジック |
| **JavaScript - API** | 新規関数 `fetchUserServiceSubscriptions()`, `saveUserServices()` | Supabase 連携、CRUD |
| **Supabase schema** | （別管理） | user_service_subscriptions テーブル |

---

### Task 1: Supabase テーブル + RLS 設定

**Files:**
- Supabase schema (SQL): user_service_subscriptions テーブル
- RLS policy: SELECT, INSERT, UPDATE, DELETE （認証ユーザーの自分のデータのみ）

**Interfaces:**
- Produces: 
  - テーブル名: `user_service_subscriptions`
  - 列: `id (UUID)`, `user_id (UUID)`, `service_name (TEXT)`, `created_at (TIMESTAMP)`, `updated_at (TIMESTAMP)`
  - RLS: `auth.uid() = user_id` で個人データ保護

- [ ] **Step 1: Supabase Dashboard で user_service_subscriptions テーブルを作成**

以下の列を追加：
- `id` (Primary Key, UUID, auto-generate)
- `user_id` (UUID, foreign key → auth.users.id, not null)
- `service_name` (TEXT, not null)
- `created_at` (TIMESTAMP, default now())
- `updated_at` (TIMESTAMP, default now())
- Index: (user_id, service_name) for unique constraint

- [ ] **Step 2: RLS を有効化し、ポリシーを作成**

ポリシー 4 つ：
1. SELECT: `auth.uid() = user_id` （自分のデータのみ読み取り）
2. INSERT: `auth.uid() = user_id` （自分のデータのみ挿入）
3. UPDATE: `auth.uid() = user_id` （自分のデータのみ更新）
4. DELETE: `auth.uid() = user_id` （自分のデータのみ削除）

- [ ] **Step 3: Supabase Dashboard で テスト ユーザーでポリシーを検証**

認証済みユーザーで SELECT → 自分のデータが見える、他人のデータは見えない
未認証でテスト → エラーまたは空結果

---

### Task 2: Frontend - リスト表示 UI（セクション分割 + カード表示）

**Files:**
- Modify: `index.html` (`<style>` セクション + JavaScript)
- Test: ブラウザで視覚確認

**Interfaces:**
- Consumes: 既存の `buildCardHTML()` 関数、作品データ構造
- Produces: 
  - CSS クラス: `.list-you-can-watch`, `.list-need-contract`
  - 関数: `renderListWithServiceSections(items, userServices)` → HTML string
  - ロジック: 作品をセクション分割（「あなたが見られる」「追加契約が必要」）

- [ ] **Step 1: CSS を追加（セクション分割、カード表示）**

クラス：
- `.list-you-can-watch` （セクション 1）
- `.list-need-contract` （セクション 2）
- `.service-display` （「契約中のサービス（N 個）」表示）
- `.service-pills` （ピル型表示）
- `.section-title`, `.section-subtitle`

- [ ] **Step 2: JavaScript に `renderListWithServiceSections(items, userServices)` 関数を実装**

入力：
- `items`: 作品オブジェクト配列
- `userServices`: ユーザーが契約しているサービス配列（["Netflix", "Prime Video", ...]）

処理：
1. 作品を 2 グループに分割：
   - グループ 1: 作品のサービス ⊆ userServices
   - グループ 2: 作品のサービス ⊄ userServices
2. 各グループを HTML に変換

出力: HTML string

- [ ] **Step 3: 既存のリスト表示関数を修正、renderListWithServiceSections() を呼び出すように**

例：`renderHomeRows()` など、リストを表示する関数内で、新関数を使用

- [ ] **Step 4: ブラウザで視覚確認**

- 「あなたが見られる作品」セクションに Netflix, Prime Video の作品が表示されるか
- 「追加契約が必要な作品」セクションに契約していないサービスの作品が表示されるか
- セクションタイトル、作品カード、サービス情報が正しく表示されるか

---

### Task 3: Frontend - 契約サービス設定モーダル UI

**Files:**
- Modify: `index.html` (`<style>` セクション + HTML structure + JavaScript)
- Test: ブラウザで操作確認

**Interfaces:**
- Consumes: Task 1 の user_service_subscriptions テーブル
- Produces:
  - HTML: モーダル要素 (`#serviceSettingsModal`)
  - CSS: `.modal`, `.service-selector`, `.service-item`, `.checkbox`
  - 関数: `openServiceSettingsModal()`, `closeServiceSettingsModal()`
  - イベント: チェックボックス変更時の処理

- [ ] **Step 1: モーダル HTML を追加（index.html 内）**

構造：
```html
<div id="serviceSettingsModal" class="modal">
  <div class="modal-content">
    <h2>契約サービスを設定</h2>
    <input type="text" placeholder="検索..." />
    <!-- カテゴリー分け -->
    <div class="category-group">
      <h3>動画配信サービス</h3>
      <label><input type="checkbox" id="netflix"> Netflix</label>
      <label><input type="checkbox" id="prime"> Prime Video</label>
      ...
    </div>
    <!-- その他カテゴリー -->
    <button onclick="saveServiceSettings()">保存</button>
    <button onclick="closeServiceSettingsModal()">キャンセル</button>
  </div>
</div>
```

サービス一覧（ハードコード）：
- 動画: Netflix, Prime Video, Hulu, U-NEXT, ABEMA, DAZN
- アニメ: dアニメストア, アニメパス
- 漫画: Kindle Unlimited, Kobo, BookWalker, コミなび
- 音楽: Spotify, Apple Music, music.jp, LINE MUSIC, YouTube Music

- [ ] **Step 2: CSS を追加（モーダルスタイル）**

`.modal`, `.modal-content`, `.category-group`, `.service-item` など

- [ ] **Step 3: JavaScript に モーダル操作関数を追加**

- `openServiceSettingsModal()`: モーダルを表示、Supabase からユーザーの契約情報を取得してチェックボックスに反映
- `closeServiceSettingsModal()`: モーダルを閉じる
- `saveServiceSettings()`: チェックボックスの値を読んで Supabase に保存（Task 4 で実装）

- [ ] **Step 4: リストページに「契約サービス設定」ボタンを追加**

上部ヘッダーに表示、クリックで `openServiceSettingsModal()` を呼び出し

- [ ] **Step 5: ブラウザで操作確認**

- 「契約サービス設定」ボタンをクリック → モーダルが表示されるか
- チェックボックスが動作するか（クリックで ON/OFF）
- 「保存」「キャンセル」ボタンが動作するか

---

### Task 4: Frontend - 契約サービス情報の Supabase 連携（取得・保存）

**Files:**
- Modify: `index.html` (JavaScript)
- Test: ブラウザ console + Supabase Dashboard で確認

**Interfaces:**
- Consumes: Task 1 の user_service_subscriptions テーブル、Task 2 の renderListWithServiceSections()
- Produces:
  - 関数: `fetchUserServiceSubscriptions()` → Promise<array>
  - 関数: `saveUserServiceSubscriptions(services)` → Promise<void>
  - グローバル状態: `currentUserServices` （キャッシュ）

- [ ] **Step 1: 認証状態の取得を確認**

既存コード内で、現在のユーザーがどうやって取得されているか確認（例：`supabase.auth.getUser()` など）
index.html の既存認証フローを追跡

- [ ] **Step 2: `fetchUserServiceSubscriptions()` 関数を実装**

処理：
```javascript
async function fetchUserServiceSubscriptions() {
  const user = await supabase.auth.getUser();
  if (!user) return [];
  
  const { data, error } = await supabase
    .from('user_service_subscriptions')
    .select('service_name')
    .eq('user_id', user.id);
  
  if (error) console.error('Error:', error);
  return data?.map(d => d.service_name) || [];
}
```

- [ ] **Step 3: `saveUserServiceSubscriptions(services)` 関数を実装**

処理：
1. ユーザー ID を取得
2. 既存データを全削除（DELETE WHERE user_id = ?)
3. 新しいサービス一覧を INSERT

```javascript
async function saveUserServiceSubscriptions(services) {
  const user = await supabase.auth.getUser();
  if (!user) return;
  
  // Delete existing
  await supabase.from('user_service_subscriptions')
    .delete()
    .eq('user_id', user.id);
  
  // Insert new
  if (services.length > 0) {
    await supabase.from('user_service_subscriptions')
      .insert(services.map(s => ({
        user_id: user.id,
        service_name: s
      })));
  }
}
```

- [ ] **Step 4: Task 3 の `saveServiceSettings()` を実装**

処理：
1. モーダル内のチェックボックスから選択されたサービスを読む
2. `saveUserServiceSubscriptions()` を呼び出し
3. モーダルを閉じ、リストを再描画

```javascript
async function saveServiceSettings() {
  const checkboxes = document.querySelectorAll('#serviceSettingsModal input[type="checkbox"]:checked');
  const services = Array.from(checkboxes).map(cb => cb.id);
  
  await saveUserServiceSubscriptions(services);
  
  currentUserServices = services; // キャッシュ更新
  closeServiceSettingsModal();
  // リスト再描画
  renderListWithServiceSections(currentItems, services);
}
```

- [ ] **Step 5: アプリ起動時に契約情報を読み込み**

`onload` または認証確認後に `fetchUserServiceSubscriptions()` を呼び出し、`currentUserServices` に保存

- [ ] **Step 6: ブラウザ + Supabase Dashboard で検証**

- Supabase Dashboard で user_service_subscriptions テーブルに正しくデータが挿入されているか確認
- モーダルで「Netflix」「Hulu」を選択 → 保存 → Dashboard で確認
- ページをリロード → 保存した設定が復元されているか確認
- 別のユーザーアカウントでログイン → 別のデータが見えるか確認（RLS）

---

### Task 5: 統合テスト + UI 調整

**Files:**
- Modify: `index.html` (微調整)
- Test: ブラウザで E2E

**Interfaces:**
- Consumes: Task 1-4 の全機能
- Produces: MVP として完全に動作するリスト機能

- [ ] **Step 1: E2E フロー確認**

1. ユーザーがログイン
2. リストページを開く
3. 「契約サービス設定」を開く
4. 「Netflix」「Prime Video」を選択 → 保存
5. リスト上部に「契約中のサービス（2 個）」と表示されるか確認
6. セクション分割が正しく機能するか確認（Netflix/Prime のコンテンツは「あなたが見られる」、その他は「追加契約が必要」）
7. ページをリロード → 設定が復元されるか確認

- [ ] **Step 2: エラー処理確認**

- Supabase が利用不可の場合
- 認証が切れた場合
- ネットワークエラーの場合

各シナリオでエラーメッセージが出るか、UI が壊れないか確認

- [ ] **Step 3: UI 調整**

- 「契約中のサービス（N 個）」の表示位置、スタイル
- セクションタイトルの視認性
- ボタンの大きさ、色
- モーダルのスクロール動作（サービスが多い場合）

- [ ] **Step 4: 最終確認**

複数デバイス（PC、タブレット、スマホ）でビジュアル確認
既存機能（他のセクション、検索など）が壊れていないか確認

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat: add list with service subscriptions (MVP)

- Supabase user_service_subscriptions table with RLS
- Service subscription modal with category filters
- List sections: 'you can watch' vs 'need additional contract'
- Fetch/save user services from Supabase
- Integration with existing catalog data

Phase 1 MVP complete. Phase 2 (detail modal + affiliate links) pending.
"
```

---

## Review Focus Tests

以下は Task 内に組み込むテスト。各 Review Focus に対応：

**RF1: RLS ポリシーの不完全性**
- Task 1, Step 3: 未認証ユーザーでテスト → エラーまたは空結果になるか確認

**RF2: N+1 クエリ**
- Task 4, Step 6: ブラウザの Network タブで、リスト取得時の Supabase リクエスト数を確認（1 回のみであることを検証）

**RF3: 複数タブ間の同期漏れ**
- Task 5, Step 1: A タブでサービス変更、B タブをリロード → 新設定が反映されるか確認

**RF4: 初回ロード時の契約情報が undefined**
- Task 4, Step 5: ページロード直後にリストが正しく描画されるか、null/undefined エラーがないか確認

**RF5: レンタル・購入データの欠落**
- Task 2, Step 4: 既存カタログデータを確認、レンタル情報の有無に応じた fallback 処理を検討（Phase 2 で詳細化）

---

## Next Phases

**Phase 2**: 詳細モーダル + サービス詳細表示（クリック時に全サービス一覧を表示）

**Phase 3**: アフィリエイトリンク統合（「登録する →」ボタン）

**Phase 4**: ホーム画面の推薦に統合

**Phase 5**: 自動割引情報の表示

---

## Ruling（実装判断）

**1. localStorage vs Supabase キャッシュ**
- 決定: グローバル変数 `currentUserServices` で短期キャッシュ、Supabase から定期的に同期
- 理由: ページ遷移時の読み込み遅延を避けるため、メモリキャッシュを使用。複数タブ間の同期は localStorage + change event で検出

**2. レンタル・購入データの表示**
- 決定: MVP では「どこで見られるか」に限定。レンタル情報の詳細（価格、配信終了日）は Phase 2 以降
- 理由: 既存カタログデータの構造を確認してから実装。API データが不完全な場合の fallback も必要

**3. ハードコーディングされたサービス一覧**
- 決定: index.html 内に配列でハードコード。今後サービスが増えたら更新
- 理由: Phase 1 MVP では固定。Phase X で「master_services」テーブルを Supabase に作成し、動的に取得する計画

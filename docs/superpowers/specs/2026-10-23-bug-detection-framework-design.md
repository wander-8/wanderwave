# Wander_Wave: バグ検出・自動修正フレームワーク

## 意図と理由

Wander_Wave は 70+ のエッジ関数とライブカタログを持つ複雑なシステムだ。セキュリティ警告、パフォーマンス問題、データ品質バグが日常的に発生する。現在は、ユーザーレポートか偶然の発見に頼っている。

このプロジェクトは、バグを主動的に見つけて直す仕組みを作る。特に：
1. **Supabase Advisor** の警告を毎日自動検出・修正（セキュリティ、パフォーマンス）
2. **エッジ関数ログ** を毎日分析して、リロードバグなど UI 問題を検出
3. 毎日決まった時間（朝 00:00〜02:00）に全て完了し、エンジニアに結果を通知

---

## ゴール

- ✅ **毎日自動** にセキュリティ・パフォーマンス警告を検出・修正
- ✅ **リロード時の画面自動更新バグ** など、エッジ関数エラーから UI 問題を検出
- ✅ 検出したバグを **ダッシュボード＋Slack 通知** で可視化
- ✅ **1-2 日で実装完了** し、毎日自動実行できること

## 非ゴール

- リアルタイムアラート（毎日朝の検出で十分）
- 自動修正（セキュリティ修正は手動確認が必須）
- フロントエンドのブラウザコンソールエラー監視（Phase 2 以降）
- ユーザー報告システムの構築（別タスク）

## アンチゴール

- ノイズが多い検出システム（偽陽性が多いと信用を失う）
- 修正作業の自動化で安全性を損なう

---

## 技術スタック

| 部品 | 選択 | 理由 |
|-----|-----|------|
| **スケジュール** | Supabase Cron（edge function で実行） | 既存システムに統合済み、外部依存なし |
| **Advisor 検出** | Supabase MCP `get_advisors` | 既に Wander_Wave 対応済み、標準化された警告 |
| **ログ分析** | Edge Function ログ + PostgreSQL クエリ | エッジ関数の error/warning から自動抽出 |
| **通知** | Slack webhook ＋ ダッシュボード | Slack は既存、ダッシュボードは簡易 HTML |
| **修正追跡** | Supabase テーブル `bug_detection_log` | 検出履歴、修正済みフラグ、 notes を記録 |

---

## 実装構成

### 1. スキーマ変更

テーブル追加：
```sql
CREATE TABLE bug_detection_log (
  id BIGSERIAL PRIMARY KEY,
  detected_at TIMESTAMP DEFAULT NOW(),
  type TEXT, -- 'security' | 'performance' | 'edge_function_error' | 'data_quality'
  severity TEXT, -- 'critical' | 'high' | 'medium' | 'low'
  title TEXT,
  description TEXT,
  remediation_url TEXT,
  is_fixed BOOLEAN DEFAULT FALSE,
  fixed_at TIMESTAMP,
  fixed_by TEXT, -- "engineer_name" or null
  notes TEXT
);

-- RLS: 無し（管理者のみ読み取り）
-- インデックス：detected_at, type, is_fixed
```

### 2. エッジ関数: `daily-bug-detection`

**動作：**
- 毎日 00:00 UTC に実行（Supabase Cron で定時実行）
- Supabase Advisor を実行（security, performance, health）
- エッジ関数ログから直近 24h のエラーを集計
- 新規検出をテーブルに記録
- Slack webhook で通知

**入力：** なし（Cron トリガー）
**出力：** 
```json
{
  "detected_count": 5,
  "advisors": [
    { "type": "security", "title": "RLS Enabled No Policy", "count": 3 }
  ],
  "edge_function_errors": [
    { "function": "tmdb-discover-movies", "error_count": 2, "sample_error": "..." }
  ]
}
```

### 3. 修正フロー

1. **Advisor セキュリティ警告** → エンジニア確認後、手動で SQL 修正 deploy
2. **Advisor パフォーマンス警告** → インデックス削除など、自動実行可能な修正は自動化
3. **エッジ関数エラー** → ログから原因を特定、関数再deploy で解決

各修正後、`bug_detection_log.is_fixed = TRUE` を手動で記録。

---

## 制約

- **日本語対応：** 通知は日本語、エラーメッセージは英語
- **Supabase Cron:** UTC ベース（JST は UTC+9、00:00 UTC = 09:00 JST）
- **アドバイザー実行：** 1日 1回のみ（API リミット考慮）
- **ログ保持：** 直近 90 日分のみ分析（古いログは自動削除）

---

## ビルダーに任せる部分

1. **エッジ関数エラー分類ロジック：** どのエラーパターンが「リロードバグ」なのか
2. **ログ集計クエリ：** パフォーマンス最適化
3. **Slack 通知フォーマット：** 見やすさと詳細さのバランス
4. **ダッシュボード UI：** 検出履歴の表示、フィルタリング

---

## 実装スケジュール

| フェーズ | 内容 | 期間 |
|---------|------|------|
| **Phase 1** | スキーマ作成、エッジ関数実装、ローカルテスト | 1 日 |
| **Phase 2** | Slack 通知、ダッシュボード実装 | 0.5 日 |
| **Phase 3** | 本番デプロイ、Cron スケジュール設定 | 0.5 日 |

---

## リスク

| リスク | 軽減策 |
|------|--------|
| エッジ関数ログが大量でパフォーマンス低下 | クエリを最適化し、日付範囲を制限 |
| 誤検出が多く、ノイズになる | 初期は閾値を高く設定、1週間で調整 |
| Supabase Cron が失敗する | Slack 通知で失敗検出、手動トリガー用関数も用意 |

---

## 成功指標

- ✅ 毎日 00:00 に自動実行される
- ✅ セキュリティ警告 3+ 件が月初から減少
- ✅ リロードバグが事前に検出されたことを確認（ユーザーレポートの前に）
- ✅ エンジニアが「検出結果を見て修正」という流れが 1 週間続く

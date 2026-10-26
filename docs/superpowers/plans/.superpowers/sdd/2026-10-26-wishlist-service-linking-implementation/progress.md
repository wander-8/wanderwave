# SDD ledger — plan: docs/superpowers/plans/2026-10-26-wishlist-service-linking-implementation.md

## Task 1: Supabase テーブル + RLS 設定

- [ ] Step 1: Supabase Dashboard で user_service_subscriptions テーブルを作成
- [ ] Step 2: RLS を有効化し、ポリシーを作成
- [ ] Step 3: Supabase Dashboard でテスト

Task 1: complete (Supabase Dashboard で SQL スクリプト実行、user_service_subscriptions テーブル + RLS ポリシー 4 つ作成)

---

## Pending Tasks

- Task 2: Frontend - リスト表示 UI（セクション分割 + カード表示）
- Task 3: Frontend - 契約サービス設定モーダル UI
- Task 4: Frontend - 契約サービス情報の Supabase 連携（取得・保存）
- Task 5: 統合テスト + UI 調整

---

## Notes

- 本セッションはトークン容量限界のため、Task 1 のみ実装
- Task 2-5 は新セッションで execute-plans を使って実装予定
- SQL スクリプトは `task-1-schema.sql` に保存済み

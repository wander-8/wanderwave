# PHASE 4 デプロイガイド

## 🚀 新 discover functions のデプロイ

### 1. Syosetu discover function
**ファイル**: `supabase/functions/syosetu-discover-novels/index.ts`

**デプロイ**:
```bash
supabase functions deploy syosetu-discover-novels --project-ref wjhvifdbttlijxnreaha
```

**使用方法**:
```bash
curl -X POST "https://wjhvifdbttlijxnreaha.supabase.co/functions/v1/syosetu-discover-novels" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "genre": "romance",
    "limit": 100,
    "pages": [1, 2, 3],
    "dry_run": true
  }'
```

**パラメータ**:
- `genre`: romance, fantasy, mystery, sf, horror, action, modern, etc.
- `limit`: 一度に挿入する最大件数（デフォルト: 100）
- `pages`: 取得するページ（Syosetu API は 1ページ 30件）
- `dry_run`: true で実行せず、プレビューのみ返す

**期待効果**:
- 小説カテゴリに +500～1000 タイトル追加
- ライトノベル特化（Rakuten よりも種類豊富）

---

### 2. MyAnimeList discover function
**ファイル**: `supabase/functions/myanimelist-discover-anime/index.ts`

**デプロイ**:
```bash
supabase functions deploy myanimelist-discover-anime --project-ref wjhvifdbttlijxnreaha
```

**使用方法**:
```bash
curl -X POST "https://wjhvifdbttlijxnreaha.supabase.co/functions/v1/myanimelist-discover-anime" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{
    "order_by": "score",
    "status": "all",
    "limit": 100,
    "pages": [1, 2, 3],
    "dry_run": true
  }'
```

**パラメータ**:
- `order_by`: score（評価順）, airing_date（放映日順）, members（会員数順）
- `status`: all, airing, complete, upcoming
- `limit`: 一度に挿入する最大件数
- `pages`: 取得するページ
- `dry_run`: true で実行せず、プレビューのみ

**期待効果**:
- アニメカテゴリに +300～500 タイトル追加
- TMDb では掲載されていないマイナー作品を補足
- 古いアニメ（1980年代）もカバー

---

## 🧪 テスト手順

### Step 1: dry_run で確認
```bash
# ページ 1 のみで dry_run
curl -X POST "..." -d '{
  "genre": "fantasy",
  "limit": 10,
  "pages": [1],
  "dry_run": true
}'
```

結果を確認：
- `candidates_fetched`: API から取得した件数
- `duplicates_skipped`: 既存作品との重複数
- `would_insert`: 実際に挿入されるはずの件数
- `rows`: サンプルデータ（最初の 10 件）

### Step 2: データ品質確認
- タイトル が正規化されているか
- 説明文（description）が正しく取得されているか
- タグが適切に付与されているか
- 外部 ID（external_ids）が記録されているか

### Step 3: 本番実行
```bash
# dry_run: false で実際に挿入
curl -X POST "..." -d '{
  "genre": "fantasy",
  "limit": 100,
  "pages": [1, 2],
  "dry_run": false
}'
```

---

## 📋 実装チェックリスト

### Syosetu
- [ ] デプロイ完了
- [ ] dry_run でテスト（各ジャンル）
- [ ] データ品質確認
- [ ] 本番実行（1ページ目）
- [ ] 本番実行（2-5ページ目）

### MyAnimeList
- [ ] デプロイ完了
- [ ] dry_run でテスト（各 status）
- [ ] データ品質確認
- [ ] 本番実行（全ページ）

---

## 🎯 期待結果

実行後のカタログ統計：

| メディア | 現在 | 追加予定 | 計画後 |
|---------|------|--------|--------|
| 映画 | ? | 0 | ? |
| アニメ | ? | +300～500 | +30～50% |
| 漫画 | ? | 0 | ? |
| 小説 | ? | +500～1000 | +50～100% |
| ドラマ | ? | 0 | ? |
| 音楽 | ? | 0 | ? |

---

## 🚨 トラブルシューティング

### "API rate limit" エラー
→ sleep 時間を増やす（Syosetu: 1000ms → 2000ms）

### "Duplicate entry" エラー
→ dedup ロジックの確認。既存の unique constraint に引っかかっている可能性

### "No data returned" エラー
→ API のステータスを確認（Jikan/Syosetu が落ちてないか）

---

**準備完了。service-role-key が用意できたら、テスト → 本番実行！**

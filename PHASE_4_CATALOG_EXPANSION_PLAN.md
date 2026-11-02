# PHASE 4：カタログ拡張計画（2026年11月2日）

## 📊 現在のカタログ対応状況

### ✅ 実装済み discover functions

| メディア | ソース | 関数 | 状態 |
|---------|--------|------|------|
| **映画** | TMDb | tmdb-discover-movies | ✅ Active |
| **アニメ** | TMDb | tmdb-discover-anime | ✅ Active |
| **ドラマ** | TMDb | tmdb-discover-drama | ✅ Active |
| **漫画** | AniList | anilist-discover-manga | ✅ Active |
| **漫画** | Rakuten | rakuten-discover-manga | ✅ Active |
| **小説** | Rakuten | rakuten-discover-novel | ✅ Active |
| **音楽** | iTunes | itunes-discover-music | ✅ Active |
| **コミックス** | OpenLibrary | openlibrary-discover-comics | ✅ Active |

---

## 🎯 PHASE 4 戦略（マーケター視点）

### 基本方針（CLAUDE.md より）
- **ニッチ・オブスキュア作品を優先**（「recognizable ones」ではなく）
- **quality threshold を緩和**し、depth を優先
- **breadth over depth** → すべてのメディアで「深く掘る」

---

## 📈 各メディアの拡張案

### 1. **映画（Movies）**
**現状**：TMDb が main source

**拡張案**：
- [ ] IMDb から補足（特にアジア映画、indie films）
- [ ] 地域別フィルタを活用（日本映画、韓国映画など）
- [ ] 古い映画・マイナー映画を掘る（1980年代以前）

**期待**：+500～1000 タイトル

---

### 2. **アニメ（Anime）**
**現状**：TMDb

**拡張案**：
- [ ] MyAnimeList（MAL）から追加（TMDb 未掲載の作品多い）
- [ ] 劇場版アニメ・OVA を拡張
- [ ] 古いアニメ（1980年代、90年代）を掘る

**期待**：+300～500 タイトル

---

### 3. **漫画（Manga）**
**現状**：AniList + Rakuten（楽天）

**拡張案**：
- [ ] pixiv で連載中の漫画を追加
- [ ] KindleUnlimited 専売漫画（Rakuten に無い）
- [ ] Web漫画・投稿作品

**期待**：+200～400 タイトル

---

### 4. **小説（Novels）**
**現状**：Rakuten（主に出版小説）

**拡張案**：
- [ ] **ライトノベル**：Kakuyomu, Syosetu（小説家になろう）
- [ ] 自費出版・電子書籍専売小説
- [ ] 古典文学（青空文庫）

**期待**：+500～1000 タイトル

---

### 5. **ドラマ（Drama）**
**現状**：TMDb（国別フィルタ）

**拡張案**：
- [ ] 韓国ドラマ深掘り（Netflix、Rakuten Viki データ）
- [ ] 中華ドラマ（Bilibili など）
- [ ] 日本ドラマ（TVer メタデータ）

**期待**：+300～500 タイトル

---

### 6. **音楽（Music）**
**現状**：iTunes（アルバム中心）

**拡張案**：
- [ ] Spotify に移行（より豊富なメタデータ）
- [ ] プレイリスト情報を活用
- [ ] ジャンル・ムード検索を強化

**期待**：+1000～5000 タイトル

---

## 🔧 実装優先順位

### **優先度 1（即座、効果大）**
```
1. ライトノベル追加（Syosetu）
   → 小説カテゴリが大きく充実
   
2. MyAnimeList 統合
   → アニメの穴を埋める
```

### **優先度 2（1-2週間）**
```
3. 古い映画・アニメの掘り起こし
   → カテゴリの depth を大幅向上
   
4. Rakuten Viki でドラマ拡張
```

### **優先度 3（継続的）**
```
5. pixiv 漫画、Web 小説
6. Spotify への音楽 migration
```

---

## 📋 実装チェックリスト

### Syosetu（小説家になろう）統合
- [ ] API 確認（スクレイピング or 公式 API）
- [ ] edge function を作成：`syosetu-discover-novels`
- [ ] media_type: "novel" で登録
- [ ] タイトル正規化（なろう特有の「123456番」削除）

### MyAnimeList 統合
- [ ] API 確認（Jikan v4 使用）
- [ ] edge function を作成：`myanimelist-discover-anime`
- [ ] TMDb との dedup（同じ作品が重複しないか確認）

---

## 🚀 次のアクション

1. **今日**：計画レビュー + Syosetu API 調査
2. **明日**：Syosetu discover function 実装
3. **3日後**：MyAnimeList 統合
4. **1週間後**：パフォーマンス測定（UA 経由でカタログ充実を確認）

---

**目標**：4 ユーザーから「あれ、こんなに作品あったの！」という反応を得る

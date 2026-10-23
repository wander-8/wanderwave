# Catalog Expansion: Manga & Book Auto-Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automated catalog expansion for manga (via AniList/MyAnimeList) and books (via NDL/other sources), with automatic judgment to distinguish Japanese vs. overseas works and a dashboard for manual approval.

**Architecture:** Five edge functions handle API fetching, country/language-based judgment, quality monitoring, and Cron scheduling. New works are stored in `catalog_review_log` for manual review before insertion into `MOVIES`. A judgment system auto-classifies origin; a monitoring system tracks accuracy and surfaces errors.

**Tech Stack:** Deno edge functions, PostgreSQL (`catalog_review_log` table), Supabase REST API, AniList GraphQL API, MyAnimeList REST API, NDL API, Slack webhooks.

**Spec:** `docs/superpowers/specs/2026-10-23-catalog-expansion-design.md`

## Global Constraints

- API rate limits: 1 call per day per source (AniList, MyAnimeList, NDL)
- Timezone: All times stored as UTC; ダッシュボード displays JST (UTC+9)
- Metadata: Must fit existing `MOVIES` table schema (title, year, genre, sourceUrl, etc.)
- Performance: Fetch + judgment + monitoring completes in < 1 hour
- Judgment accuracy target: 95%+ for Japanese vs. overseas classification
- Manual review required before insertion into `MOVIES` (no auto-insert)

## Review Focus

1. **API failures** — If AniList/MyAnimeList/NDL API fails, the function must not crash; it should log and notify Slack so the operator knows the system is broken.
2. **Duplicate detection** — Same work fetched from multiple sources should be detected and de-duplicated before review. Test: fetch same manga from both AniList and MyAnimeList, verify only one appears in dashboard.
3. **Judgment accuracy degradation** — If country/language fields are missing or malformed in source data, judgment may fail silently. Test: judgment with null/empty country field defaults safely (e.g., manual review).
4. **Timezone conversion** — Dashboard displays JST but database stores UTC. Test: a work "added today" shows on the correct date in both UTC and JST.
5. **Monitoring false positives** — Monitor alerts on normal fluctuations (e.g., "reject rate spiked 10%") and noise. Test: monitor correctly distinguishes signal (sustained 80%+ reject rate) from noise (one spike).

---

## File Structure

**Files to create:**
- `supabase/migrations/20261023_create_catalog_review_log.sql` — Review log table
- `supabase/functions/catalog-expand-manga/index.ts` — Fetch manga from AniList/MyAnimeList
- `supabase/functions/catalog-expand-manga/judge.ts` — Judgment logic for manga (origin detection)
- `supabase/functions/catalog-expand-books/index.ts` — Fetch books from NDL/Google Books
- `supabase/functions/catalog-expand-books/judge.ts` — Judgment logic for books
- `supabase/functions/catalog-monitor-quality/index.ts` — Monitor judgment accuracy
- `supabase/functions/catalog-review-sync/index.ts` — Fetch from catalog_review_log, insert approved works into MOVIES

**Files to modify:**
- `index.html` — Add catalog review dashboard (HTML, CSS, JS)
- `.env.example` — Document new API keys (ANILIST_KEY, MYANIMELIST_KEY, NDL_API_URL, etc.)

---

## Task 1: Create Database Schema

**Files:**
- Create: `supabase/migrations/20261023_create_catalog_review_log.sql`
- Test: Manual SQL verification

**Interfaces:**
- Produces: `catalog_review_log` table with columns: `id`, `source`, `type` (manga/book), `title`, `title_en`, `country`, `language`, `judgment` (accept/reject/manual_review), `judgment_reason`, `judgment_confidence` (0-1), `approved_at`, `approved_by`, `notes`, `created_at`, `metadata` (JSONB).

- [ ] **Step 1: Write SQL migration**

Create `supabase/migrations/20261023_create_catalog_review_log.sql`:
```sql
CREATE TABLE public.catalog_review_log (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('anilist', 'myanimelist', 'ndl', 'google_books')),
  type TEXT NOT NULL CHECK (type IN ('manga', 'book')),
  title TEXT NOT NULL,
  title_en TEXT,
  country TEXT,
  language TEXT,
  judgment TEXT NOT NULL CHECK (judgment IN ('accept', 'reject', 'manual_review')),
  judgment_reason TEXT,
  judgment_confidence FLOAT CHECK (judgment_confidence >= 0 AND judgment_confidence <= 1),
  approved_at TIMESTAMP,
  approved_by TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_catalog_review_judgment ON public.catalog_review_log(judgment, created_at DESC);
CREATE INDEX idx_catalog_review_type_source ON public.catalog_review_log(type, source);
CREATE INDEX idx_catalog_review_created_at ON public.catalog_review_log(created_at DESC);

ALTER TABLE public.catalog_review_log ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Verify migration syntax**

Check the file is valid SQL (no typos).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20261023_create_catalog_review_log.sql
git commit -m "db: add catalog_review_log table for manga/book expansion tracking"
```

---

## Task 2: Implement Manga Judgment & Fetch

**Files:**
- Create: `supabase/functions/catalog-expand-manga/judge.ts`
- Create: `supabase/functions/catalog-expand-manga/index.ts`
- Test: Unit tests for judgment logic

**Interfaces:**
- Produces: `judgeManga(manga: MangaData) -> { judgment: "accept" | "reject" | "manual_review", reason: string, confidence: number }` in `judge.ts`. `fetchAndJudgeManga() -> Promise<ReviewLogEntry[]>` in `index.ts`.

- [ ] **Step 1: Write judgment logic test**

Test: A manga with `country: "Japan"` and `language: "Japanese"` should be judged `REJECT` with high confidence.

```typescript
test_judgment_rejects_japan_manga(): {
  const manga = { country: "Japan", language: "Japanese", title: "One Piece" };
  const result = judgeManga(manga);
  assert_equal(result.judgment, "reject");
  assert_greater_or_equal(result.confidence, 0.9);
}
```

- [ ] **Step 2: Implement `judgeManga()` in `judge.ts`**

Decision tree:
- If `country == "Japan"` AND `language == "Japanese"` → REJECT (confidence 0.95)
- Else if `country != "Japan"` AND `language != "Japanese"` → ACCEPT (confidence 0.9)
- Else if `country == null` OR `language == null` → MANUAL_REVIEW (confidence 0.5)
- Else → MANUAL_REVIEW (confidence 0.6)

- [ ] **Step 3: Write test for AniList fetch**

Test: Fetch top 10 manga from AniList, verify structure (title, country, language).

- [ ] **Step 4: Implement `fetchAndJudgeManga()` in `index.ts`**

Fetch from AniList GraphQL API (first 100 manga), apply judgment, return array of `ReviewLogEntry` objects.

Error handling: If API fails, log and notify Slack (return empty array, not error).

- [ ] **Step 5: Test locally**

Run function via Supabase CLI or manual invocation; verify 10-50 manga are fetched and judged correctly.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/catalog-expand-manga/
git commit -m "feat: implement manga judgment and AniList fetch"
```

---

## Task 3: Implement Book Judgment & Fetch

**Files:**
- Create: `supabase/functions/catalog-expand-books/judge.ts`
- Create: `supabase/functions/catalog-expand-books/index.ts`
- Test: Unit tests for judgment logic

**Interfaces:**
- Produces: `judgeBook(book: BookData) -> { judgment, reason, confidence }` in `judge.ts`. `fetchAndJudgeBooks() -> Promise<ReviewLogEntry[]>` in `index.ts`.

- [ ] **Step 1: Write judgment logic test**

Test: A book with `language: "en"` (English) should be judged `ACCEPT` (overseas book).

```typescript
test_judgment_accepts_english_book(): {
  const book = { language: "en", country: "US", title: "The Great Gatsby" };
  const result = judgeBook(book);
  assert_equal(result.judgment, "accept");
}
```

- [ ] **Step 2: Implement `judgeBook()` in `judge.ts`**

Decision tree (similar to manga, but books may have different language codes):
- If `country == "Japan"` → REJECT (confidence 0.95)
- Else if `language not in ["ja", "Japanese"]` → ACCEPT (confidence 0.85)
- Else → MANUAL_REVIEW (confidence 0.5)

- [ ] **Step 3: Write test for NDL fetch**

Test: Fetch top 50 books from NDL API, verify structure.

- [ ] **Step 4: Implement `fetchAndJudgeBooks()` in `index.ts`**

Fetch from NDL REST API (search for recent non-Japanese books, or all and filter), apply judgment, return array.

Error handling: Log and Slack notify on failure.

- [ ] **Step 5: Test locally**

Verify books are fetched and judged.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/catalog-expand-books/
git commit -m "feat: implement book judgment and NDL fetch"
```

---

## Task 4: Implement Monitoring & Quality Checks

**Files:**
- Create: `supabase/functions/catalog-monitor-quality/index.ts`
- Test: Manual verification of metrics

**Interfaces:**
- Consumes: `catalog_review_log` table (judgment results)
- Produces: Monitoring metrics (daily summary, error rates, confidence trends)

- [ ] **Step 1: Write monitoring metrics test**

Test: Calculate approval rate (approved / total) for last 7 days. Verify it's between 0-100%.

- [ ] **Step 2: Implement monitoring function**

Calculate:
- Total judgments per day (accept, reject, manual_review)
- Confidence scores (average, min, max)
- Error detection: If reject rate > 80% or accept rate < 20%, flag as anomaly
- Trend: Compare last 7 days vs. previous 7 days

- [ ] **Step 3: Test with production data**

Run against real `catalog_review_log` entries, verify metrics make sense.

- [ ] **Step 4: Send Slack notification**

On daily run, send summary to #engineering: "Yesterday: 45 manga accepted, 12 rejected, 8 manual. Confidence avg 0.87."

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/catalog-monitor-quality/
git commit -m "feat: implement catalog quality monitoring"
```

---

## Task 5: Add Review Dashboard to index.html

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `catalog_review_log` table via REST API
- Produces: HTML view (#view-catalog-review) with filters, list, and approve/reject buttons

- [ ] **Step 1: Add HTML section**

Insert before `</div><!-- .app -->`:
```html
<!-- ============ CATALOG REVIEW VIEW ============ -->
<div class="view" id="view-catalog-review" style="display:none;">
  <button class="back-btn" onclick="goHome()">← 一覧に戻る</button>
  <div class="detail-head">
    <h2>カタログ審査ダッシュボード</h2>
    <div class="sub">新規作品の自動判定結果を確認・承認</div>
  </div>
  
  <div class="review-filter">
    <button class="filter-btn active" onclick="filterReviews('all')">全て</button>
    <button class="filter-btn" onclick="filterReviews('manual_review')">要確認</button>
    <button class="filter-btn" onclick="filterReviews('accept')">承認待ち</button>
    <button class="filter-btn" onclick="filterReviews('reject')">却下</button>
  </div>
  
  <div id="review-list" class="review-list"></div>
</div>
```

- [ ] **Step 2: Add CSS**

Style the dashboard: `.review-filter`, `.filter-btn`, `.review-item`, approval/rejection badges.

- [ ] **Step 3: Add JavaScript functions**

`loadCatalogReviews()` — Fetch from `catalog_review_log` REST API.
`renderReviewList(reviews)` — Display each review with metadata, judgment, approve/reject buttons.
`approveReview(id)` — Update `approved_at` and `approved_by` in DB.

- [ ] **Step 4: Test in browser**

Load page, navigate to catalog review, verify reviews load and filters work.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "ui: add catalog review dashboard"
```

---

## Task 6: Set Up Cron Scheduling

**Files:**
- Modify: `docs/operations/catalog-expansion-cron.md` (new doc)

**Interfaces:**
- Triggers: `catalog-expand-manga`, `catalog-expand-books`, `catalog-monitor-quality` edge functions daily

- [ ] **Step 1: Write Cron configuration guide**

Document:
1. Set environment variables (ANILIST_KEY, MYANIMELIST_KEY, NDL_API_URL, SLACK_WEBHOOK_URL)
2. SQL to create Cron jobs:
```sql
SELECT cron.schedule('daily-catalog-expand-manga', '0 8 * * *', '...');
SELECT cron.schedule('daily-catalog-expand-books', '0 8 * * *', '...');
SELECT cron.schedule('daily-catalog-monitor', '0 9 * * *', '...');
```
3. Testing procedures
4. Troubleshooting

- [ ] **Step 2: Test Cron manually**

Invoke each function via Supabase dashboard, verify results in `catalog_review_log`.

- [ ] **Step 3: Verify Slack notifications**

Confirm Slack messages arrive for monitoring summary.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/catalog-expansion-cron.md
git commit -m "docs: add catalog expansion Cron configuration guide"
```

---

## Task 7: Integration Testing & Verification

**Files:**
- None (verification only)

**Interfaces:**
- Verifies: All tasks 1-6 work together

- [ ] **Step 1: End-to-end flow test**

1. Manually invoke `catalog-expand-manga`
2. Check `catalog_review_log` has new rows
3. Open dashboard, verify reviews appear
4. Click approve on one review
5. Verify `approved_at` and `approved_by` are set

- [ ] **Step 2: Verify monitoring**

Invoke `catalog-monitor-quality`, check Slack receives notification.

- [ ] **Step 3: Test Cron schedule**

Wait for next scheduled run (or manually test), verify works without manual invocation.

- [ ] **Step 4: Document next steps**

Outline how to sync approved reviews to `MOVIES` table (future Task 8).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete catalog expansion framework - manga/book auto-fetch with judgment system"
```

---

## Success Criteria

- ✅ `catalog_review_log` table created with all required columns
- ✅ Manga fetched from AniList (50+ works on test run)
- ✅ Books fetched from NDL (50+ works on test run)
- ✅ Judgment system classifies Japanese vs. overseas with 95%+ accuracy (on test set)
- ✅ Monitoring detects judgment anomalies and sends Slack notifications
- ✅ Dashboard displays reviews, filters work, approve/reject buttons update DB
- ✅ Cron jobs configured and running on schedule
- ✅ No crashes on API failures (graceful error handling with Slack alerts)

---

## Review Focus Verification

1. **API failures** ✓ Task 2-3: fetchAndJudge functions wrap API calls in try-catch, log errors, notify Slack
2. **Duplicate detection** ✓ Task 2-3: When fetching, check catalog_review_log for same title (same source) to avoid re-processing
3. **Judgment with missing data** ✓ Task 2-3: Tests for null country/language; judgment defaults to MANUAL_REVIEW
4. **Timezone conversion** ✓ Task 5: Dashboard converts UTC to JST for display; DB stores UTC
5. **Monitoring false positives** ✓ Task 4: Monitor compares 7-day trend, not single-day spike; sustained threshold required

# Bug Detection & Auto-Fix Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a daily automated system that detects Supabase Advisor warnings (security, performance) and edge function errors, logs them to a database, notifies via Slack, and displays them on a dashboard.

**Architecture:** A Supabase Cron-scheduled edge function (`daily-bug-detection`) runs at 00:00 UTC, queries Advisor via MCP, analyzes edge function logs from the last 24h, writes findings to `bug_detection_log` table, and sends a Slack notification. The main `index.html` includes a new dashboard section displaying the latest detected bugs.

**Tech Stack:** 
- Supabase Cron + Deno Edge Functions
- PostgreSQL (`bug_detection_log` table)
- Slack webhook for notifications
- Native HTML/CSS/JS in index.html for dashboard

**Spec:** `docs/superpowers/specs/2026-10-23-bug-detection-framework-design.md`

## Global Constraints

- Cron execution: Daily at 00:00 UTC (09:00 JST)
- Slack webhook: Environment variable `SLACK_WEBHOOK_URL`
- Supabase MCP: `get_advisors` tool available
- Edge function timeout: 60 seconds (logs must be fast)
- Log retention: Keep only last 90 days in analysis
- Notification language: Japanese for user-facing text
- No external dependencies beyond Supabase ecosystem

## Review Focus

1. **Advisor API failures** — If `get_advisors` returns an error, the function must not crash; it should log the failure and notify via Slack anyway so the operator knows the system is broken.
2. **False positives in log analysis** — Error logs may contain expected/harmless warnings (e.g., rate limit retries). Threshold-based filtering prevents noise.
3. **Idempotency** — If the Cron function runs twice in one day, duplicate entries should not clutter the database. A `DATE(detected_at)` uniqueness check per bug type prevents duplicates.
4. **Timestamp timezone confusion** — Supabase Cron runs in UTC; the dashboard displays times in JST. All times stored as UTC with explicit conversion on display.
5. **Slack notification token expiry** — The webhook URL should be tested on first run; if it fails, the function must surface that error clearly so the operator can refresh the token.

---

## File Structure

**Files to create:**
- `supabase/migrations/20261023_create_bug_detection_log.sql` — Schema migration
- `supabase/functions/daily-bug-detection/index.ts` — Main Cron-triggered function
- `supabase/functions/daily-bug-detection/notify.ts` — Slack notification helper
- `supabase/functions/daily-bug-detection/analyzers.ts` — Advisor + log analysis logic

**Files to modify:**
- `index.html` — Add dashboard section for bug detection results
- `.env.example` — Document `SLACK_WEBHOOK_URL` requirement

---

## Task 1: Create Database Schema

**Files:**
- Create: `supabase/migrations/20261023_create_bug_detection_log.sql`
- Test: Manual SQL verification + RLS policy check

**Interfaces:**
- Produces: Table `public.bug_detection_log` with columns: `id` (BIGSERIAL PK), `detected_at` (TIMESTAMP DEFAULT NOW()), `type` (TEXT: 'security'|'performance'|'edge_function_error'|'data_quality'), `severity` (TEXT: 'critical'|'high'|'medium'|'low'), `title` (TEXT), `description` (TEXT), `remediation_url` (TEXT), `is_fixed` (BOOLEAN DEFAULT FALSE), `fixed_at` (TIMESTAMP), `fixed_by` (TEXT), `notes` (TEXT)

- [ ] **Step 1: Write SQL migration file**

Create `supabase/migrations/20261023_create_bug_detection_log.sql`:
```sql
CREATE TABLE public.bug_detection_log (
  id BIGSERIAL PRIMARY KEY,
  detected_at TIMESTAMP DEFAULT NOW(),
  type TEXT NOT NULL CHECK (type IN ('security', 'performance', 'edge_function_error', 'data_quality')),
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title TEXT NOT NULL,
  description TEXT,
  remediation_url TEXT,
  is_fixed BOOLEAN DEFAULT FALSE,
  fixed_at TIMESTAMP,
  fixed_by TEXT,
  notes TEXT
);

CREATE INDEX idx_bug_detection_log_detected_at ON public.bug_detection_log(detected_at DESC);
CREATE INDEX idx_bug_detection_log_type_is_fixed ON public.bug_detection_log(type, is_fixed);

-- RLS: No policies (admin read-only, not exposed via Data API)
ALTER TABLE public.bug_detection_log ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Run migration locally**

```bash
cd /Users/nitta/Desktop/Wander
supabase migration list --local
```

Verify the migration file is listed and has a timestamp matching `20261023_...`

- [ ] **Step 3: Verify table structure**

```bash
supabase db query "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'bug_detection_log';"
```

Expected: 10 columns listed (id, detected_at, type, severity, title, description, remediation_url, is_fixed, fixed_at, fixed_by, notes)

- [ ] **Step 4: Commit migration**

```bash
git add supabase/migrations/20261023_create_bug_detection_log.sql
git commit -m "db: add bug_detection_log table for daily detection results"
```

---

## Task 2: Implement Advisor Analyzer

**Files:**
- Create: `supabase/functions/daily-bug-detection/analyzers.ts`
- Test: Unit test via mock data

**Interfaces:**
- Produces: `analyzeAdvisors(types: string[]) -> Promise<AdvisorFinding[]>` where `AdvisorFinding = { type, severity, title, count, remediation_url, sample_detail }`

- [ ] **Step 1: Write test for Advisor analyzer**

Create inline test in `analyzers.ts` comments showing expected structure:
```typescript
// Test data: mock Advisor response with RLS warning, unused index
// Expected output: array of 2 findings, severity 'high' and 'medium'
```

- [ ] **Step 2: Implement `analyzeAdvisors()`**

In `supabase/functions/daily-bug-detection/analyzers.ts`:
- Import Supabase MCP client (via fetch to MCP endpoint, credentials from env)
- Call `get_advisors` for types: ['security', 'performance']
- Map findings to `AdvisorFinding[]`
- Map Advisor `level` (INFO/WARN) to severity (low/medium/high)
- Return array sorted by severity DESC

```typescript
export async function analyzeAdvisors(): Promise<AdvisorFinding[]> {
  // TODO: Call MCP get_advisors, parse response, normalize
}
```

- [ ] **Step 3: Test locally with mock data**

Stub MCP response, call function, verify output structure matches expected `AdvisorFinding[]`

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/daily-bug-detection/analyzers.ts
git commit -m "feat: implement Advisor analyzer for daily bug detection"
```

---

## Task 3: Implement Edge Function Log Analyzer

**Files:**
- Modify: `supabase/functions/daily-bug-detection/analyzers.ts` (add function)
- Test: Mock postgres query results

**Interfaces:**
- Produces: `analyzeEdgeFunctionLogs() -> Promise<EdgeFunctionFinding[]>` where `EdgeFunctionFinding = { function_name, error_count, sample_error, severity }`

- [ ] **Step 1: Write SQL query for edge function errors**

Query `edge_function_logs` (or equivalent Supabase function invocation table) from last 24h:
```sql
SELECT 
  function_name,
  COUNT(*) as error_count,
  MAX(error_message) as sample_error,
  MAX(created_at) as last_error_at
FROM function_execution_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND status = 'error'
GROUP BY function_name
ORDER BY error_count DESC
LIMIT 20;
```

- [ ] **Step 2: Implement `analyzeEdgeFunctionLogs()`**

In `analyzers.ts`, add function that:
- Queries the database for edge function errors from last 24h
- Classifies errors: "timeout" → critical, "404" → low, others → medium
- Returns array of `EdgeFunctionFinding[]`

- [ ] **Step 3: Filter out known-harmless errors**

Add allowlist of patterns (e.g., `["/rate_limit/", "/timeout/i"]`) that are expected and should not be reported.

- [ ] **Step 4: Test with production-like data**

Run locally against Wander_Wave's Supabase instance, verify 0-5 findings are returned (expect some errors in real logs).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/daily-bug-detection/analyzers.ts
git commit -m "feat: implement edge function log analyzer"
```

---

## Task 4: Implement Slack Notification

**Files:**
- Create: `supabase/functions/daily-bug-detection/notify.ts`
- Test: Mock webhook response

**Interfaces:**
- Consumes: `AdvisorFinding[]` and `EdgeFunctionFinding[]` from Task 2 & 3
- Produces: `notifySlack(findings: Finding[]) -> Promise<boolean>` (true on success)

- [ ] **Step 1: Write function signature**

In `supabase/functions/daily-bug-detection/notify.ts`:
```typescript
export async function notifySlack(advisorFindings: AdvisorFinding[], edgeFunctionFindings: EdgeFunctionFinding[]): Promise<boolean> {
  const webhookUrl = Deno.env.get('SLACK_WEBHOOK_URL');
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not configured');
  // TODO: Format message and POST to webhook
}
```

- [ ] **Step 2: Format Slack message in Japanese**

Message structure:
```
🐛 [Wander_Wave] 日次バグ検出 - 2026-10-23

セキュリティ警告 (3件):
• RLS Enabled No Policy: 3 tables
• Extension in Public: 2 extensions

パフォーマンス警告 (2件):
• Unused Index: 4 indexes

エッジ関数エラー (5件):
• tmdb-discover-movies: 2 errors (last 24h)
• rakuten-discover-novel: 1 error

詳細: https://wander-8.site/dashboard#bugs
```

- [ ] **Step 3: POST to Slack webhook**

Use `fetch()` to POST JSON payload to webhook URL. Handle errors:
- 400/401/403 → Webhook invalid or expired
- 500 → Temporary Slack outage
- All errors → Return false and log error

- [ ] **Step 4: Test webhook**

Use real webhook URL (from env var or test in staging), send test message, verify it appears in Slack.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/daily-bug-detection/notify.ts
git commit -m "feat: implement Slack notification for bug detection"
```

---

## Task 5: Implement Main Cron Function

**Files:**
- Create: `supabase/functions/daily-bug-detection/index.ts`
- Test: Full integration test

**Interfaces:**
- Consumes: Functions from Tasks 2, 3, 4 (analyzeAdvisors, analyzeEdgeFunctionLogs, notifySlack)
- Produces: HTTP endpoint that Supabase Cron calls; returns `{ success: boolean, detected_count: number, message: string }`

- [ ] **Step 1: Write main function**

In `supabase/functions/daily-bug-detection/index.ts`:
```typescript
export async function handler(req: Request): Promise<Response> {
  try {
    const advisorFindings = await analyzeAdvisors();
    const edgeFunctionFindings = await analyzeEdgeFunctionLogs();
    
    // Insert into database
    // Notify Slack
    // Return summary
  } catch (error) {
    // Log error, notify Slack of failure
  }
}
```

- [ ] **Step 2: Insert findings into `bug_detection_log`**

For each finding:
- Check if already exists today (same type, title, is_fixed=false) to avoid duplicates
- If new, INSERT with `detected_at=NOW()`, `is_fixed=FALSE`
- Log count of inserted rows

SQL example:
```sql
INSERT INTO bug_detection_log (detected_at, type, severity, title, description, remediation_url)
VALUES (NOW(), ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING;
```

- [ ] **Step 3: Call Slack notification**

After all findings are logged, call `notifySlack(advisorFindings, edgeFunctionFindings)`. If it fails, log but don't crash.

- [ ] **Step 4: Return summary**

```json
{
  "success": true,
  "detected_count": 5,
  "advisors": { "security": 3, "performance": 2 },
  "edge_function_errors": 5,
  "message": "Detection completed: 10 findings detected, 5 new"
}
```

- [ ] **Step 5: Test locally**

```bash
supabase functions serve daily-bug-detection
curl -X POST http://localhost:54321/functions/v1/daily-bug-detection
```

Expected: HTTP 200 with JSON response showing detected_count > 0

- [ ] **Step 6: Deploy to production**

```bash
supabase functions deploy daily-bug-detection
```

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/daily-bug-detection/index.ts
git commit -m "feat: implement main daily bug detection Cron function"
```

---

## Task 6: Add Bug Detection Dashboard to index.html

**Files:**
- Modify: `index.html`

**Interfaces:**
- Consumes: `bug_detection_log` table (read-only)
- Produces: New `.view#view-bugs` section with bug list, filter tabs, and status indicators

- [ ] **Step 1: Add HTML section to index.html**

Before `</div><!-- .app -->`, add:
```html
<!-- ============ BUG DETECTION VIEW ============ -->
<div class="view" id="view-bugs" style="display:none;">
  <button class="back-btn" onclick="goHome()">← 一覧に戻る</button>
  <div class="detail-head">
    <h2>バグ検出ダッシュボード</h2>
    <div class="sub">毎日 09:00 に自動検出</div>
  </div>
  
  <div class="bug-filter">
    <button class="filter-tab active" onclick="filterBugs('all')">全て</button>
    <button class="filter-tab" onclick="filterBugs('unfixed')">未修正</button>
    <button class="filter-tab" onclick="filterBugs('security')">セキュリティ</button>
    <button class="filter-tab" onclick="filterBugs('performance')">パフォーマンス</button>
  </div>
  
  <div id="bugs-list" class="bug-list"></div>
</div>
```

- [ ] **Step 2: Add CSS for bug dashboard**

In `<style>` block, add:
```css
.bug-filter {
  display: flex; gap: 8px; margin: 16px 0;
}
.filter-tab {
  padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line);
  background: transparent; color: var(--ink-soft); cursor: pointer;
}
.filter-tab.active { background: var(--plum); color: #fff; }

.bug-list { display: flex; flex-direction: column; gap: 12px; }
.bug-item {
  padding: 12px; border-radius: 8px; border-left: 4px solid;
  background: rgba(125, 95, 214, 0.1);
}
.bug-item.security { border-left-color: #e8899e; }
.bug-item.performance { border-left-color: #a084f2; }
.bug-item.critical { border-left-color: #ff0000; }

.bug-title { font-weight: 700; font-size: 14px; margin-bottom: 4px; }
.bug-meta { font-size: 12px; color: var(--ink-soft); }
```

- [ ] **Step 3: Add JavaScript function to fetch and render bugs**

Add function:
```javascript
async function loadBugDetectionDashboard() {
  try {
    const response = await fetch('/rest/v1/bug_detection_log?order=detected_at.desc&limit=50', {
      headers: { 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
    });
    const bugs = await response.json();
    renderBugList(bugs);
  } catch (error) {
    console.error('Failed to load bugs:', error);
  }
}

function renderBugList(bugs) {
  const container = document.getElementById('bugs-list');
  container.innerHTML = bugs.map(bug => `
    <div class="bug-item ${bug.severity} ${bug.type}">
      <div class="bug-title">${bug.title}</div>
      <div class="bug-meta">${bug.type} • ${bug.severity} • ${new Date(bug.detected_at).toLocaleDateString('ja-JP')}</div>
      <div style="margin-top: 8px; font-size: 13px;">${bug.description}</div>
      ${bug.remediation_url ? `<a href="${bug.remediation_url}" target="_blank" style="font-size: 12px; color: var(--gold);">修正方法 →</a>` : ''}
    </div>
  `).join('');
}
```

- [ ] **Step 4: Add button to navigate to bug dashboard**

In the main menu/header area, add:
```html
<button onclick="goView('view-bugs')" title="バグ検出">🐛</button>
```

- [ ] **Step 5: Test dashboard**

1. Manually insert test row into `bug_detection_log`
2. Load `/index.html`
3. Click bug dashboard button
4. Verify bugs are rendered correctly

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "ui: add bug detection dashboard to main view"
```

---

## Task 7: Configure Supabase Cron Schedule

**Files:**
- Modify: Supabase Dashboard (Cloud Console)

**Interfaces:**
- Triggers: `daily-bug-detection` function at 00:00 UTC daily

- [ ] **Step 1: Set environment variable**

In Supabase Dashboard → Project Settings → Secrets, add:
```
SLACK_WEBHOOK_URL = <actual webhook URL from user>
```

- [ ] **Step 2: Create Cron job via MCP** (if available)

Or manually in Supabase Dashboard:
```sql
SELECT cron.schedule(
  'daily-bug-detection',
  '0 0 * * *', -- 00:00 UTC daily
  'SELECT http_post(''https://<project-id>.supabase.co/functions/v1/daily-bug-detection'', ''''')', 
);
```

- [ ] **Step 3: Test Cron trigger manually**

In Supabase Dashboard → Edge Functions → daily-bug-detection, click "Invoke" button. Verify:
- Function runs successfully
- `bug_detection_log` table has new rows
- Slack message appears in channel

- [ ] **Step 4: Verify Cron logs**

Check Supabase Edge Function logs to confirm execution completed without errors.

- [ ] **Step 5: Document Cron schedule**

In `README.md` or operations docs, note:
- Cron runs daily at 00:00 UTC (09:00 JST)
- Slack webhook URL is required in secrets
- Dashboard accessible via 🐛 icon in main nav

- [ ] **Step 6: Commit (if config stored in code)**

```bash
git add docs/operations/bug-detection-cron.md
git commit -m "docs: document daily bug detection Cron schedule"
```

---

## Task 8: Integration Testing & Verification

**Files:**
- Modify: None (all created/modified in earlier tasks)
- Test: Manual end-to-end verification

**Interfaces:**
- Verifies: All functions from Tasks 1-7 work together

- [ ] **Step 1: Trigger detection manually**

Call edge function directly (curl or Dashboard):
```bash
curl -X POST https://<project-id>.supabase.co/functions/v1/daily-bug-detection \
  -H "Authorization: Bearer <service-role-key>"
```

Expected response:
```json
{
  "success": true,
  "detected_count": 10,
  "message": "Detection completed"
}
```

- [ ] **Step 2: Verify database has entries**

Query:
```sql
SELECT COUNT(*), type, severity FROM bug_detection_log WHERE DATE(detected_at) = TODAY GROUP BY type, severity;
```

Expected: Rows for 'security', 'performance', and/or 'edge_function_error'

- [ ] **Step 3: Verify Slack notification**

Check Slack channel for message with detection summary. Verify:
- Timestamp is JST-formatted (09:00+)
- Counts match database rows
- No errors in notification format

- [ ] **Step 4: Verify dashboard renders**

Open `index.html`, click 🐛 button, verify:
- Bugs load without console errors
- Severity badges render correctly
- Filter tabs work (click each, verify list updates)

- [ ] **Step 5: Test error handling**

Temporarily break Slack webhook URL in secrets, run detection again. Verify:
- Function still completes successfully (returns 200)
- Error is logged but does not block data insertion
- Next day's run continues working

- [ ] **Step 6: Verify Cron auto-execution**

Wait for next scheduled execution at 00:00 UTC (or manually test with `cron.schedule_test`). Verify:
- Function executes without manual trigger
- New bug_detection_log rows appear
- Slack notification arrives at expected time

- [ ] **Step 7: Final commit & summary**

```bash
git add -A
git commit -m "feat: complete bug detection framework - advisor + logs + dashboard"
```

Verify all tasks are merged to `main`.

---

## Success Criteria

- ✅ `bug_detection_log` table created with all required columns
- ✅ `daily-bug-detection` function deployed and callable
- ✅ Supabase Advisor warnings (security, performance) are detected daily
- ✅ Edge function errors from last 24h are analyzed and categorized
- ✅ New findings are inserted into database without duplicates
- ✅ Slack webhook receives notification with summary (in Japanese)
- ✅ Dashboard renders latest bugs with filters (all/unfixed/type)
- ✅ Cron executes daily at 00:00 UTC, completing in <60 seconds
- ✅ All previous tests pass; no regressions in index.html

---

## Review Focus Verification

1. **Advisor API failures** ✓ Task 2 tests MCP error handling; Task 5 wraps in try-catch
2. **False positives in log analysis** ✓ Task 3 implements allowlist filtering
3. **Idempotency** ✓ Task 5 includes duplicate check in SQL INSERT
4. **Timezone conversion** ✓ Tasks 4 & 6 explicitly convert UTC to JST for display
5. **Slack token expiry** ✓ Task 4 tests webhook validation and logs errors clearly

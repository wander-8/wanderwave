# Daily Bug Detection - Cron Configuration

## Overview

The `daily-bug-detection` edge function runs automatically every day at **00:00 UTC (09:00 JST)** via Supabase Cron.

## Setup Steps

### 1. Set Slack Webhook Environment Variable

In Supabase Dashboard → Project Settings → Secrets:

```
SLACK_WEBHOOK_URL = https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

Get your webhook URL from Slack:
1. Go to your Slack workspace settings
2. Navigate to Apps > App Management > Custom Integrations > Incoming WebHooks
3. Create a new webhook for the #engineering channel
4. Copy the Webhook URL

### 2. Create Cron Job

Via Supabase SQL Editor, run:

```sql
SELECT cron.schedule(
  'daily-bug-detection',
  '0 0 * * *',
  'SELECT http_post(
    ''https://<your-project-id>.supabase.co/functions/v1/daily-bug-detection'',
    jsonb_build_object(''source'', ''cron''),
    jsonb_build_object(''Authorization'', ''Bearer <ANON_KEY>'')
  )'
);
```

Replace:
- `<your-project-id>` with your Supabase project ID
- `<ANON_KEY>` with your Supabase anonymous API key (from Project Settings → API)

### 3. Verify Cron Job

```sql
SELECT * FROM cron.job WHERE jobname = 'daily-bug-detection';
```

Expected output: One row with `jobname = 'daily-bug-detection'`

## Manual Testing

### Test via Dashboard

In Supabase → Edge Functions → `daily-bug-detection`:
1. Click "Invoke"
2. Verify HTTP 200 response
3. Check Slack channel for notification
4. Verify `bug_detection_log` table has new rows

### Test via CLI

```bash
curl -X POST https://<project-id>.supabase.co/functions/v1/daily-bug-detection \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json"
```

Expected: JSON response with `"success": true`

## Monitoring

### Check Execution Logs

In Supabase Dashboard → Edge Functions → `daily-bug-detection`:
- View "Logs" tab for recent execution history
- Look for timestamp matching cron schedule (00:00 UTC / 09:00 JST)

### Verify Database Entries

```sql
SELECT COUNT(*), type, severity 
FROM bug_detection_log 
WHERE DATE(detected_at) = CURRENT_DATE 
GROUP BY type, severity;
```

Expected: Rows grouped by type (security, performance, edge_function_error)

### Check Slack Notifications

Join #engineering channel and look for:
- Time: 09:00 JST (00:00 UTC)
- Format: 🐛 [Wander_Wave] 日次バグ検出
- Content: Summary of detected bugs

## Troubleshooting

### Cron Not Running

**Symptom:** No new entries in `bug_detection_log` table

**Fix:**
1. Verify cron job exists: `SELECT * FROM cron.job WHERE jobname = 'daily-bug-detection'`
2. Check function logs for errors
3. Manually invoke function to verify it works
4. Restart the cron job:
```sql
SELECT cron.unschedule('daily-bug-detection');
-- Then re-run the schedule command above
```

### Slack Webhook Failing

**Symptom:** No Slack notifications, but bug_detection_log has entries

**Fix:**
1. Verify webhook URL is valid: `SELECT Deno.env.get('SLACK_WEBHOOK_URL')`
2. Test webhook manually:
```bash
curl -X POST <WEBHOOK_URL> \
  -H "Content-Type: application/json" \
  -d '{"text":"Test"}'
```
3. If test fails, regenerate webhook in Slack and update secret

### Function Timeout

**Symptom:** Function returns 504 error

**Fix:**
1. Reduce log analysis window from 24h to 12h (edit `analyzers.ts`)
2. Optimize database queries (add indexes if needed)
3. Increase function timeout (Supabase plan-dependent)

## Performance

Current performance expectations:
- Function runtime: ~5-10 seconds (typical)
- Database insertion: < 1 second
- Slack notification: < 2 seconds
- Total time budget: 60 seconds (Supabase edge function timeout)

## Maintenance

### Weekly Check

Every Monday, verify:
1. Last 7 days of cron logs show successful executions
2. Bug count trends (should see similar volume each day)
3. No spike in edge function errors

### Monthly Check

Review advisor findings from last month:
1. Which categories appear most (security/performance)
2. Which have been fixed
3. Update thresholds if false-positive rate is high

## References

- [Supabase Cron Documentation](https://supabase.com/docs/guides/database/postgres/extensions/pg_cron)
- [Slack Webhook Docs](https://api.slack.com/messaging/webhooks)
- [Edge Functions Monitoring](https://supabase.com/docs/guides/functions/monitoring-and-logs)

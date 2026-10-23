# Catalog Expansion - Cron Configuration

## Setup

### 1. Set Environment Variables

In Supabase Dashboard → Project Settings → Secrets:

```
ANILIST_KEY=<api_key>
MYANIMELIST_KEY=<api_key>
NDL_API_URL=https://api.example.com/ndl
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL
```

### 2. Create Cron Jobs

```sql
-- Manga expansion (08:00 UTC / 17:00 JST)
SELECT cron.schedule(
  'daily-catalog-expand-manga',
  '0 8 * * *',
  'SELECT http_post(''https://<project-id>.supabase.co/functions/v1/catalog-expand-manga'', ''{}'')'
);

-- Book expansion (08:30 UTC / 17:30 JST)
SELECT cron.schedule(
  'daily-catalog-expand-books',
  '30 8 * * *',
  'SELECT http_post(''https://<project-id>.supabase.co/functions/v1/catalog-expand-books'', ''{}'')'
);

-- Quality monitoring (09:00 UTC / 18:00 JST)
SELECT cron.schedule(
  'daily-catalog-monitor-quality',
  '0 9 * * *',
  'SELECT http_post(''https://<project-id>.supabase.co/functions/v1/catalog-monitor-quality'', ''{}'')'
);
```

### 3. Test Manually

- Dashboard: Supabase → Edge Functions → catalog-expand-manga → Invoke
- Verify entries appear in `catalog_review_log` table
- Check Slack channel for monitoring notification

## Monitoring

- **Dashboard**: Home → Catalog Review (📚 icon)
- **Slack**: #engineering channel for daily summaries
- **Database**: `catalog_review_log` table with judgment results

## Troubleshooting

If Cron doesn't run:
1. Check Supabase Cron logs
2. Verify function is deployed
3. Test function manually via Dashboard
4. Ensure API credentials are valid in Secrets

---

**Status**: Ready for deployment

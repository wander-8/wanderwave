-- Setup Cron jobs for catalog expansion
-- Run these in Supabase SQL Editor

SELECT cron.schedule('daily-catalog-expand-manga', '0 8 * * *', 'SELECT http_post(''https://wjhvifdbttlijxnreaha.supabase.co/functions/v1/catalog-expand-manga'', ''{}'')');
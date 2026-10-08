-- Run after 202610080001_audience.sql. Supabase supports pg_cron.
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'ayla-audience-cleanup',
  '* * * * *',
  'select ayla_private.cleanup_audience();'
);

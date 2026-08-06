-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Adds tracking for automated booking-reminder emails on the existing
-- `later_bookings` table. Reminder windows (before pickup):
--   180 days, 60 days, 30 days, 48 hours, 24 hours, 12 hours, 6 hours, 4 hours.
--
-- `reminder_emails_sent` stores a JSON array of window keys that have already
-- been sent (e.g. ["180d","48h","4h"]) so the cron job can dedupe and never
-- resend the same reminder twice.

alter table public.later_bookings
  add column if not exists reminder_emails_sent jsonb not null default '[]'::jsonb;

-- Backfill any nulls on existing rows.
update public.later_bookings
set reminder_emails_sent = coalesce(reminder_emails_sent, '[]'::jsonb)
where reminder_emails_sent is null;

-- Helpful index for the reminder cron job: future, non-cancelled pickups.
create index if not exists later_bookings_reminder_lookup_idx
  on public.later_bookings (pickup_at)
  where pickup_at is not null;

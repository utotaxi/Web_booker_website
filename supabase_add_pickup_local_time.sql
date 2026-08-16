-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Restores the local (UK) pickup date/time text columns the email notifiers
-- prefer, so reminder / driver-assigned / confirmation / trip-completed
-- emails show the same UK wall-clock time the rider entered at booking
-- (BST in summer, GMT in winter) instead of the UTC-converted `pickup_at`.
--
-- `pickup_date` ("YYYY-MM-DD") and `pickup_time` ("HH:MM") are the local
-- values the web booker sends. The POST /api/bookings route already writes
-- them (its insert only keeps columns that exist on the table), so new web
-- bookings are populated automatically once the columns exist.
--
-- Existing rows are backfilled from `pickup_at` (timestamptz) converted to
-- Europe/London, which handles the DST switch automatically.

alter table public.later_bookings
  add column if not exists pickup_date text,
  add column if not exists pickup_time text;

-- Backfill any rows missing the local time from the UTC pickup_at.
-- `pickup_at AT TIME ZONE 'Europe/London'` yields the UK wall-clock instant
-- (BST in summer, GMT in winter); to_char formats it the way the rider sees it.
update public.later_bookings
set pickup_date = to_char(pickup_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD'),
    pickup_time = to_char(pickup_at AT TIME ZONE 'Europe/London', 'HH24:MI')
where pickup_at is not null
  and (pickup_date is null or pickup_time is null);

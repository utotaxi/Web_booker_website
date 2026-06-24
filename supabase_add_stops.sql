-- ============================================================================
-- Add "Additional Stops" support (up to 8 stops) to the later_bookings table.
-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Safe to run multiple times. After running, stops saved from the web booker
-- will be stored here and visible to every system that reads later_bookings.
-- ============================================================================

alter table public.later_bookings
  -- Structured list of stop addresses, in order. Example:
  --   ["Stop A, London, UK", "Stop B, London, UK"]
  add column if not exists stops jsonb not null default '[]'::jsonb,
  -- Human readable version for systems that do not parse JSON.
  --   "Stop A, London, UK -> Stop B, London, UK"
  add column if not exists stops_text text,
  -- Number of additional stops (0 to 8).
  add column if not exists stops_count integer not null default 0;

-- Enforce the "up to 8 stops" rule at the database level too.
alter table public.later_bookings
  drop constraint if exists later_bookings_stops_count_check;

alter table public.later_bookings
  add constraint later_bookings_stops_count_check
  check (stops_count >= 0 and stops_count <= 8);

-- ----------------------------------------------------------------------------
-- Return journey support. Each leg's distance and fare is calculated and the
-- total is stored in estimated_fare / distance_miles / duration_minutes.
-- ----------------------------------------------------------------------------
alter table public.later_bookings
  add column if not exists outbound_distance_miles numeric(10,2),
  add column if not exists outbound_duration_minutes integer,
  add column if not exists outbound_fare numeric(10,2),
  add column if not exists return_pickup_address text,
  add column if not exists return_dropoff_address text,
  add column if not exists return_stops jsonb not null default '[]'::jsonb,
  add column if not exists return_stops_text text,
  add column if not exists return_stops_count integer not null default 0,
  -- The return leg can carry a different number of passengers / luggage.
  add column if not exists return_passengers integer,
  add column if not exists return_luggage integer,
  add column if not exists return_at timestamptz,
  add column if not exists return_distance_miles numeric(10,2),
  add column if not exists return_duration_minutes integer,
  add column if not exists return_fare numeric(10,2);

alter table public.later_bookings
  drop constraint if exists later_bookings_return_stops_count_check;

alter table public.later_bookings
  add constraint later_bookings_return_stops_count_check
  check (return_stops_count >= 0 and return_stops_count <= 8);

-- Backfill any existing rows so the new columns are never null.
update public.later_bookings
set
  stops = coalesce(stops, '[]'::jsonb),
  stops_count = coalesce(stops_count, 0),
  return_stops = coalesce(return_stops, '[]'::jsonb),
  return_stops_count = coalesce(return_stops_count, 0);

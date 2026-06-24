-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- This migration keeps your existing `later_bookings` table and only adds
-- missing columns needed by the web booker for stops + dynamic pricing.

alter table public.later_bookings
  add column if not exists stops jsonb not null default '[]'::jsonb,
  add column if not exists stops_text text,
  add column if not exists stops_count integer not null default 0,
  add column if not exists pricing_rule_id uuid,
  add column if not exists pricing_rule_name text,
  add column if not exists pricing_breakdown jsonb not null default '{}'::jsonb,
  add column if not exists quote_source text,
  add column if not exists quote_currency text not null default 'GBP';

-- Personal details captured on the web booker checkout step.
alter table public.later_bookings
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists email text,
  add column if not exists phone_number text,
  add column if not exists booking_for_someone_else boolean default false,
  add column if not exists flight_info text,
  add column if not exists arrival_from text,
  add column if not exists additional_note text;

-- Compatibility columns for implementations that still use old names.
alter table public.later_bookings
  add column if not exists pickup text,
  add column if not exists dropoff text,
  add column if not exists vehicle text,
  add column if not exists return_journey boolean default false;

-- Ensure commonly used web-booker columns exist if the table was created
-- from a different template.
alter table public.later_bookings
  add column if not exists pickup_address text,
  add column if not exists dropoff_address text,
  add column if not exists pickup_at timestamptz,
  add column if not exists vehicle_type text,
  add column if not exists estimated_fare numeric(10,2),
  add column if not exists distance_miles numeric(10,2),
  add column if not exists duration_minutes integer,
  add column if not exists booking_type text,
  add column if not exists passengers integer,
  add column if not exists luggage integer,
  add column if not exists status text default 'pending';

-- Return journey support. Each leg can have its own stops, passengers and
-- luggage; per-leg distance/fare is stored alongside the trip totals.
alter table public.later_bookings
  add column if not exists outbound_distance_miles numeric(10,2),
  add column if not exists outbound_duration_minutes integer,
  add column if not exists outbound_fare numeric(10,2),
  add column if not exists return_pickup_address text,
  add column if not exists return_dropoff_address text,
  add column if not exists return_stops jsonb not null default '[]'::jsonb,
  add column if not exists return_stops_text text,
  add column if not exists return_stops_count integer not null default 0,
  add column if not exists return_passengers integer,
  add column if not exists return_luggage integer,
  add column if not exists return_at timestamptz,
  add column if not exists return_distance_miles numeric(10,2),
  add column if not exists return_duration_minutes integer,
  add column if not exists return_fare numeric(10,2);

-- Backfill old rows to avoid null JSON payloads.
update public.later_bookings
set
  stops = coalesce(stops, '[]'::jsonb),
  stops_count = coalesce(stops_count, 0),
  pricing_breakdown = coalesce(pricing_breakdown, '{}'::jsonb),
  quote_currency = coalesce(quote_currency, 'GBP'),
  return_stops = coalesce(return_stops, '[]'::jsonb),
  return_stops_count = coalesce(return_stops_count, 0);

-- Keep table private to anon users; server inserts use service-role key.
alter table public.later_bookings enable row level security;

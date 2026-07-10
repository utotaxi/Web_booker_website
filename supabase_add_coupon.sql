-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Adds coupon fields to later_bookings so discounted web-booker fares
-- are stored alongside the original quote.

alter table public.later_bookings
  add column if not exists coupon_id uuid,
  add column if not exists coupon_code text,
  add column if not exists coupon_name text,
  add column if not exists coupon_discount_percent numeric(5,2),
  add column if not exists coupon_discount_amount numeric(10,2),
  add column if not exists original_fare numeric(10,2);

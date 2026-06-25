-- ============================================================================
-- Add customer contact details (name, email, phone number) to later_bookings.
-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Safe to run multiple times. After running, the web booker will store the
-- passenger's name, email and phone number on every booking.
-- ============================================================================

alter table public.later_bookings
  -- Full name (first + last) entered on the checkout step.
  add column if not exists name text,
  -- Kept for systems that read the split name fields.
  add column if not exists first_name text,
  add column if not exists last_name text,
  -- Contact email address.
  add column if not exists email text,
  -- Contact phone number.
  add column if not exists phone_number text;

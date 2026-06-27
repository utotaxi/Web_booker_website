-- ============================================================================
-- Add Stripe payment tracking columns to later_bookings.
-- Run this in the Supabase SQL Editor:
--   https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new
--
-- Safe to run multiple times. After running, every paid web booking stores the
-- Stripe PaymentIntent id, payment status, amount paid, and payment method.
-- ============================================================================

alter table public.later_bookings
  -- Stripe PaymentIntent id (pi_...). Use this to reconcile in the Stripe dashboard.
  add column if not exists payment_intent_id text,
  -- 'paid' once the rider has successfully paid before booking.
  add column if not exists payment_status text,
  -- Amount actually charged, in GBP (pounds).
  add column if not exists amount_paid numeric(10,2),
  -- Payment provider used, e.g. 'stripe'.
  add column if not exists payment_method text;

import type { SupabaseClient } from "@supabase/supabase-js";

export const COUPONS_TABLE = "coupons";

export interface CouponRow {
  id: string;
  code: string;
  name: string | null;
  discount: number;
  redemptions: number;
}

export interface AppliedCoupon {
  id: string;
  code: string;
  name: string | null;
  discount_percent: number;
  discount_amount: number;
  original_fare: number;
  final_fare: number;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Look up a coupon by code in Supabase. Matching is case-insensitive.
 * Throws if the code is missing or not found.
 */
export async function findValidCoupon(
  supabase: SupabaseClient,
  rawCode: string
): Promise<CouponRow> {
  const code = normalizeCouponCode(rawCode);
  if (!code) {
    throw new Error("Please enter a coupon code.");
  }

  const { data, error } = await supabase
    .from(COUPONS_TABLE)
    .select("id, code, name, discount, redemptions")
    .ilike("code", code)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not verify coupon: ${error.message}`);
  }

  if (!data) {
    throw new Error("This coupon code is not valid.");
  }

  const discount = Number(data.discount);
  if (!Number.isFinite(discount) || discount <= 0 || discount > 100) {
    throw new Error("This coupon is misconfigured and cannot be applied.");
  }

  return {
    id: String(data.id),
    code: String(data.code),
    name: data.name == null ? null : String(data.name),
    discount,
    redemptions: Number(data.redemptions) || 0,
  };
}

/** Apply a percentage discount from the coupons table to a fare in GBP. */
export function applyCouponDiscount(
  originalFare: number,
  coupon: CouponRow
): AppliedCoupon {
  const fare = Number.isFinite(originalFare) ? Math.max(0, originalFare) : 0;
  const percent = Math.min(100, Math.max(0, coupon.discount));
  const discountAmount = round((fare * percent) / 100, 2);
  const finalFare = round(Math.max(0, fare - discountAmount), 2);

  return {
    id: coupon.id,
    code: coupon.code,
    name: coupon.name,
    discount_percent: percent,
    discount_amount: discountAmount,
    original_fare: round(fare, 2),
    final_fare: finalFare,
  };
}

/**
 * Validate a coupon code against Supabase and return the discounted fare.
 * Pass an empty/blank code to skip (returns null).
 */
export async function resolveCouponForFare(
  supabase: SupabaseClient,
  rawCode: string | null | undefined,
  originalFare: number
): Promise<AppliedCoupon | null> {
  if (!rawCode?.trim()) return null;
  const coupon = await findValidCoupon(supabase, rawCode);
  return applyCouponDiscount(originalFare, coupon);
}

/** Increment redemption count after a successful booking. */
export async function incrementCouponRedemption(
  supabase: SupabaseClient,
  couponId: string
): Promise<void> {
  const { data, error: readError } = await supabase
    .from(COUPONS_TABLE)
    .select("redemptions")
    .eq("id", couponId)
    .maybeSingle();

  if (readError || !data) return;

  const next = (Number(data.redemptions) || 0) + 1;
  await supabase.from(COUPONS_TABLE).update({ redemptions: next }).eq("id", couponId);
}

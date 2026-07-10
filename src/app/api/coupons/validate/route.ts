import { NextRequest, NextResponse } from "next/server";
import {
  applyCouponDiscount,
  findValidCoupon,
} from "@/lib/coupons";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ValidatePayload {
  code?: string;
  fare?: number;
}

export async function POST(req: NextRequest) {
  let payload: ValidatePayload;
  try {
    payload = (await req.json()) as ValidatePayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const code = payload.code?.trim() ?? "";
  if (!code) {
    return NextResponse.json(
      { error: "Please enter a coupon code." },
      { status: 400 }
    );
  }

  const fare = Number(payload.fare);
  if (!Number.isFinite(fare) || fare < 0) {
    return NextResponse.json(
      { error: "A valid fare is required to apply a coupon." },
      { status: 400 }
    );
  }

  try {
    const supabase = getSupabaseAdmin();
    const coupon = await findValidCoupon(supabase, code);
    const applied = applyCouponDiscount(fare, coupon);

    return NextResponse.json({
      valid: true,
      coupon: applied,
    });
  } catch (error) {
    return NextResponse.json(
      {
        valid: false,
        error: (error as Error).message || "Invalid coupon code.",
      },
      { status: 400 }
    );
  }
}

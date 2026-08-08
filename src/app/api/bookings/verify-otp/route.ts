import { NextRequest, NextResponse } from "next/server";
import { BOOKINGS_TABLE, getSupabaseAdmin } from "@/lib/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Verifies a ride-start PIN. The driver app calls this when the rider shares
 * their PIN to begin the trip:
 *
 *   POST /api/bookings/verify-otp
 *   Header: x-cron-secret: <CRON_SECRET>
 *   Body:   { "id": "<supabase-row-id>", "otp": "4827" }
 *           or { "bookingReference": "UTO-AB12CD34", "otp": "4827" }
 *
 * Returns { valid: true } on a match, { valid: false } otherwise. Reuses
 * CRON_SECRET so the endpoint isn't a brute-forceable public oracle.
 */

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.warn(
      "[Verify OTP] CRON_SECRET is not set — endpoint is unauthenticated. Set CRON_SECRET in production."
    );
    return true;
  }
  const provided =
    req.headers.get("x-cron-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.nextUrl.searchParams.get("secret");
  return provided === secret;
}

function bookingReferenceFromId(id: string): string {
  return `UTO-${String(id).slice(0, 8).toUpperCase()}`;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: string; bookingReference?: string; otp?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const otp = body.otp?.trim();
  if (!otp) {
    return NextResponse.json({ error: "otp is required." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  let idFilter: string | undefined;
  if (body.id?.trim()) {
    idFilter = body.id.trim();
  } else if (body.bookingReference?.trim()) {
    const ref = body.bookingReference.trim().toUpperCase();
    const hex = (ref.startsWith("UTO-") ? ref.slice(4) : ref).toLowerCase();
    if (!/^[0-9a-f]{1,8}$/.test(hex)) {
      return NextResponse.json({ error: "Invalid bookingReference format." }, { status: 400 });
    }
    const pad8Min = hex.padEnd(8, "0");
    const pad8Max = hex.padEnd(8, "f");
    const minUuid = `${pad8Min}-0000-0000-0000-000000000000`;
    const maxUuid = `${pad8Max}-ffff-ffff-ffff-ffffffffffff`;

    const { data: matches, error: listErr } = await supabase
      .from(BOOKINGS_TABLE)
      .select("id")
      .gte("id", minUuid)
      .lte("id", maxUuid)
      .limit(10);
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const match = (matches ?? []).find((r: { id: string }) => bookingReferenceFromId(r.id).toUpperCase() === `UTO-${hex.toUpperCase()}`);
    if (!match) {
      return NextResponse.json({ error: `No booking found for reference ${body.bookingReference}.` }, { status: 404 });
    }
    idFilter = match.id;
  } else {
    return NextResponse.json({ error: "Provide 'id' or 'bookingReference' in the body." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select("id, otp, status")
    .eq("id", idFilter)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }

  const storedOtp = (data.otp as string | null)?.trim() ?? "";
  const valid = storedOtp.length > 0 && storedOtp === otp.trim();

  return NextResponse.json(
    {
      valid,
      bookingReference: bookingReferenceFromId(data.id as string),
      status: data.status,
    },
    { status: 200 }
  );
}

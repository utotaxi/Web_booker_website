import { NextRequest, NextResponse } from "next/server";
import { BOOKINGS_TABLE, getSupabaseAdmin } from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Marks a booking as completed and sends the trip-completed receipt email
 * (with the Google review request).
 *
 * Call this from your driver / dispatch system when a trip finishes:
 *   POST /api/bookings/complete
 *   Header: x-cron-secret: <CRON_SECRET>
 *   Body:   { "id": "<supabase-row-id>" }
 *           or { "bookingReference": "UTO-AB12CD34" }
 *
 * Reuses CRON_SECRET as the internal API secret. Idempotent: re-completing an
 * already-completed booking re-sends nothing unless `force` is true.
 */

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.warn(
      "[Bookings Complete] CRON_SECRET is not set — endpoint is unauthenticated. Set CRON_SECRET in production."
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

interface BookingRow {
  id: string;
  status: string | null;
  pickup_at: string | null;
  pickup_date: string | null;
  pickup_time: string | null;
  pickup_address: string | null;
  pickup: string | null;
  dropoff_address: string | null;
  dropoff: string | null;
  vehicle_type: string | null;
  vehicle: string | null;
  passengers: number | null;
  estimated_fare: number | string | null;
  payment_method: string | null;
  payment_status: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  customer_email: string | null;
  customer_name: string | null;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: string; bookingReference?: string; force?: boolean };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  // Resolve the booking by row id, or by booking reference (UTO-<id8>).
  let query = supabase.from(BOOKINGS_TABLE).select(`
      id, status, pickup_at, pickup_date, pickup_time,
      pickup_address, pickup, dropoff_address, dropoff,
      vehicle_type, vehicle, passengers, estimated_fare,
      payment_method, payment_status,
      name, first_name, last_name, email, customer_email, customer_name
    `);

  let idFilter: string | undefined;
  if (body.id?.trim()) {
    idFilter = body.id.trim();
  } else if (body.bookingReference?.trim()) {
    // Reference is UTO-<first8 of id>; match by prefix (case-insensitive).
    const ref = body.bookingReference.trim().toUpperCase();
    const hex = ref.startsWith("UTO-") ? ref.slice(4) : ref;
    if (!/^[0-9A-F]{1,8}$/.test(hex)) {
      return NextResponse.json(
        { error: "Invalid bookingReference format." },
        { status: 400 }
      );
    }
    // Fetch all and filter client-side — ids are UUIDs, so we match on the
    // uppercased 8-char prefix the same way bookingReferenceFromId builds it.
    const { data: all, error: listErr } = await supabase
      .from(BOOKINGS_TABLE)
      .select("id")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const match = (all ?? []).find((r: { id: string }) =>
      bookingReferenceFromId(r.id).toUpperCase() === `UTO-${hex}`
    );
    if (!match) {
      return NextResponse.json(
        { error: `No booking found for reference ${body.bookingReference}.` },
        { status: 404 }
      );
    }
    idFilter = match.id;
  } else {
    return NextResponse.json(
      { error: "Provide 'id' or 'bookingReference' in the body." },
      { status: 400 }
    );
  }

  const { data, error } = await query.eq("id", idFilter).maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }

  const row = data as BookingRow;
  const recipient = row.email?.trim() || row.customer_email?.trim();

  if (!recipient) {
    return NextResponse.json(
      { error: "Booking has no passenger email; cannot send receipt." },
      { status: 400 }
    );
  }

  // Don't double-fire the receipt unless explicitly forced.
  const alreadyCompleted =
    row.status?.trim().toLowerCase() === "completed";
  if (alreadyCompleted && !body.force) {
    return NextResponse.json(
      {
        success: true,
        message: "Booking already completed. Receipt not re-sent (pass force=true to resend).",
        bookingReference: bookingReferenceFromId(row.id),
      },
      { status: 200 }
    );
  }

  // Mark completed.
  if (!alreadyCompleted) {
    const { error: updErr } = await supabase
      .from(BOOKINGS_TABLE)
      .update({ status: "completed" })
      .eq("id", row.id);
    if (updErr) {
      return NextResponse.json(
        { error: `Failed to mark completed: ${updErr.message}` },
        { status: 500 }
      );
    }
  }

  const bookingReference = bookingReferenceFromId(row.id);
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  const passengerName =
    first || last ? `${first ?? ""} ${last ?? ""}`.trim()
    : row.name?.trim() || row.customer_name?.trim() || "Valued Customer";

  const fareRaw = row.estimated_fare;
  const fareNum = typeof fareRaw === "number" ? fareRaw : Number(fareRaw);
  const fareDisplay =
    fareRaw === null || fareRaw === undefined || fareRaw === ""
      ? "0.00"
      : Number.isFinite(fareNum)
        ? fareNum.toFixed(2)
        : String(fareRaw);

  const paymentMethod = row.payment_method?.trim()
    ? row.payment_method.trim().toLowerCase() === "stripe"
      ? "Credit Card (Stripe)"
      : row.payment_method.trim()
    : row.payment_status?.trim()?.toLowerCase() === "coupon"
      ? "Coupon Discount"
      : "Pay in Vehicle";

  const emailData: BookingEmailData = {
    bookingReference,
    passengerName,
    passengerEmail: recipient,
    pickupDate: row.pickup_date?.trim() || (row.pickup_at ? row.pickup_at.split("T")[0] : "N/A"),
    pickupTime: row.pickup_time?.trim() || (row.pickup_at ? row.pickup_at.split("T")[1]?.slice(0, 5) ?? "N/A" : "N/A"),
    pickupAddress: row.pickup_address?.trim() || row.pickup?.trim() || "N/A",
    dropoffAddress: row.dropoff_address?.trim() || row.dropoff?.trim() || "N/A",
    vehicleType: row.vehicle_type?.trim() || row.vehicle?.trim() || "Standard Vehicle",
    passengers: row.passengers ?? 1,
    estimatedFare: fareDisplay,
    paymentMethod,
  };

  const sendResult = await sendBookingEmail({
    to: recipient,
    type: "trip_completed",
    data: emailData,
  });

  if (!sendResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: sendResult.error,
        details: sendResult.details,
        bookingReference,
      },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      success: true,
      message: `Trip receipt sent to ${recipient} for booking ${bookingReference}.`,
      messageId: sendResult.messageId,
      bookingReference,
    },
    { status: 200 }
  );
}

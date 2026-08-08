import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
  getSupabaseTableColumns,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Assigns a driver (and vehicle) to a booking and sends the
 * "driver_assigned" email to the passenger automatically.
 *
 * Call this from your driver / dispatch system the moment a driver is
 * allocated — instead of writing driver details to Supabase directly:
 *
 *   POST /api/bookings/assign
 *   Header: x-cron-secret: <CRON_SECRET>
 *   Body:   {
 *             "id": "<supabase-row-id>",                 // or "bookingReference": "UTO-AB12CD34"
 *             "driverName": "John Smith",
 *             "driverPhone": "07123456789",
 *             "vehicleMake": "Mercedes",
 *             "vehicleModel": "E-Class",
 *             "vehicleColour": "Black",
 *             "vehicleRegistration": "AB21 CDE",
 *             "eta": "10 minutes",                       // optional
 *             "status": "assigned"                       // optional, defaults to "assigned"
 *           }
 *
 * Reuses CRON_SECRET as the internal API secret (same as /api/bookings/complete).
 * Idempotent: re-assigning an already-assigned booking does not re-send the
 * email unless `force: true` is passed.
 *
 * Only columns that actually exist on `later_bookings` are written, so missing
 * driver/vehicle columns on the table won't break the call — but the email is
 * always sent with the fields supplied in the request body.
 */

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    console.warn(
      "[Bookings Assign] CRON_SECRET is not set — endpoint is unauthenticated. Set CRON_SECRET in production."
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

interface AssignBody {
  id?: string;
  bookingReference?: string;
  driverName?: string;
  driverPhone?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColour?: string;
  vehicleRegistration?: string;
  vehiclePlate?: string;
  eta?: string;
  status?: string;
  force?: boolean;
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
  rider_email: string | null;
  rider_name: string | null;
  driver_name: string | null;
  otp: string | null;
}

function pickColumns(
  source: Record<string, unknown>,
  allowedColumns: Set<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([column, value]) => allowedColumns.has(column) && value !== undefined
    )
  );
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: AssignBody;
  try {
    body = (await req.json()) as AssignBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const driverName = body.driverName?.trim();
  if (!driverName) {
    return NextResponse.json(
      { error: "driverName is required." },
      { status: 400 }
    );
  }

  const supabase = getSupabaseAdmin();
  const allowedColumns = await getSupabaseTableColumns(BOOKINGS_TABLE);

  // Build the SELECT list dynamically so we only read columns that exist
  // (driver_name may not be present on the table yet).
  const baseSelectCols = [
    "id",
    "status",
    "pickup_at",
    "pickup_date",
    "pickup_time",
    "pickup_address",
    "pickup",
    "dropoff_address",
    "dropoff",
    "vehicle_type",
    "vehicle",
    "passengers",
    "estimated_fare",
    "payment_method",
    "payment_status",
    "name",
    "first_name",
    "last_name",
    "email",
    "customer_email",
    "customer_name",
    "rider_email",
    "rider_name",
    "driver_name",
    "otp",
  ];
  const selectCols = baseSelectCols
    .filter((c) => allowedColumns.has(c))
    .join(", ");

  // Resolve the booking by row id, or by booking reference (UTO-<id8>).
  let idFilter: string | undefined;
  if (body.id?.trim()) {
    idFilter = body.id.trim();
  } else if (body.bookingReference?.trim()) {
    const ref = body.bookingReference.trim().toUpperCase();
    const hex = ref.startsWith("UTO-") ? ref.slice(4) : ref;
    if (!/^[0-9A-F]{1,8}$/.test(hex)) {
      return NextResponse.json(
        { error: "Invalid bookingReference format." },
        { status: 400 }
      );
    }
    const { data: all, error: listErr } = await supabase
      .from(BOOKINGS_TABLE)
      .select("id")
      .order("created_at", { ascending: false })
      .limit(1000);
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const match = (all ?? []).find(
      (r: { id: string }) =>
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

  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(selectCols)
    .eq("id", idFilter)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }

  const row = data as unknown as BookingRow;
  const bookingReference = bookingReferenceFromId(row.id);
  const recipient = row.email?.trim() || row.customer_email?.trim() || row.rider_email?.trim();

  if (!recipient) {
    return NextResponse.json(
      { error: "Booking has no passenger email; cannot send driver-assigned email." },
      { status: 400 }
    );
  }

  // Idempotency: don't re-send if a driver is already assigned, unless forced.
  const alreadyAssigned = Boolean(row.driver_name?.trim());
  if (alreadyAssigned && !body.force) {
    return NextResponse.json(
      {
        success: true,
        message:
          "Booking already has a driver assigned. Email not re-sent (pass force=true to resend).",
        bookingReference,
      },
      { status: 200 }
    );
  }

  // Persist the driver / vehicle fields onto the booking (only columns that exist).
  const updatePayload = pickColumns(
    {
      driver_name: driverName,
      driver_phone: body.driverPhone?.trim() || null,
      vehicle_make: body.vehicleMake?.trim() || null,
      vehicle_model: body.vehicleModel?.trim() || null,
      vehicle_colour: body.vehicleColour?.trim() || null,
      vehicle_registration:
        body.vehicleRegistration?.trim() || body.vehiclePlate?.trim() || null,
      eta: body.eta?.trim() || null,
      status: body.status?.trim() || "assigned",
    },
    allowedColumns
  );

  if (Object.keys(updatePayload).length > 0) {
    const { error: updErr } = await supabase
      .from(BOOKINGS_TABLE)
      .update(updatePayload)
      .eq("id", row.id);
    if (updErr) {
      return NextResponse.json(
        { error: `Failed to assign driver: ${updErr.message}` },
        { status: 500 }
      );
    }
  }

  // Build passenger display name + fare exactly like /api/bookings/complete.
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  const passengerName =
    first || last
      ? `${first ?? ""} ${last ?? ""}`.trim()
      : row.name?.trim() || row.customer_name?.trim() || row.rider_name?.trim() || "Valued Customer";

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

  let ridePin = row.otp?.trim() || "";
  if (!ridePin) {
    ridePin = String(randomInt(0, 10000)).padStart(4, "0");
    const { error: otpErr } = await supabase
      .from(BOOKINGS_TABLE)
      .update({ otp: ridePin })
      .eq("id", row.id);
    if (otpErr) {
      console.warn(`[Bookings Assign] Failed to persist otp for ${bookingReference}: ${otpErr.message}`);
    }
  }

  const emailData: BookingEmailData = {
    bookingReference,
    passengerName,
    passengerEmail: recipient,
    pickupDate:
      row.pickup_date?.trim() ||
      (row.pickup_at ? row.pickup_at.split("T")[0] : "N/A"),
    pickupTime:
      row.pickup_time?.trim() ||
      (row.pickup_at ? row.pickup_at.split("T")[1]?.slice(0, 5) ?? "N/A" : "N/A"),
    pickupAddress: row.pickup_address?.trim() || row.pickup?.trim() || "N/A",
    dropoffAddress: row.dropoff_address?.trim() || row.dropoff?.trim() || "N/A",
    vehicleType: row.vehicle_type?.trim() || row.vehicle?.trim() || "Standard Vehicle",
    passengers: row.passengers ?? 1,
    estimatedFare: fareDisplay,
    paymentMethod,
    driverName,
    driverPhone: body.driverPhone?.trim(),
    vehicleMake: body.vehicleMake?.trim(),
    vehicleModel: body.vehicleModel?.trim(),
    vehicleColour: body.vehicleColour?.trim(),
    vehicleRegistration:
      body.vehicleRegistration?.trim() || body.vehiclePlate?.trim(),
    eta: body.eta?.trim(),
    ridePin,
  };

  const sendResult = await sendBookingEmail({
    to: recipient,
    type: "driver_assigned",
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
      message: `Driver-assigned email sent to ${recipient} for booking ${bookingReference}.`,
      messageId: sendResult.messageId,
      bookingReference,
    },
    { status: 200 }
  );
}

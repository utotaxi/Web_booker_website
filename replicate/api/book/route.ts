/**
 * /api/book — example booking flow that sends a confirmation email.
 * Copy to src/app/api/book/route.ts (Next.js App Router).
 *
 * Shows the pattern: persist the booking, then call sendBookingEmail.
 * The email send is awaited inside try/catch so the booking still succeeds
 * even if SMTP fails (failure is logged, not surfaced to the customer).
 *
 * Replace the "persist" block with your own DB (Supabase/Prisma/etc.).
 */
import { NextRequest, NextResponse } from "next/server";
import { sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface BookPayload {
  bookingReference?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  pickup_date?: string;
  pickup_time?: string;
  pickup?: string;
  dropoff?: string;
  vehicle?: string;
  passengers?: number;
  estimated_fare?: number | string;
  payment_method?: string;
  additional_note?: string;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json()) as BookPayload;
  const recipient = payload.email?.trim();
  if (!recipient) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 });
  }

  // 1. Persist the booking (replace with your DB call)...
  const bookingReference = payload.bookingReference || `BK-${Date.now().toString(36).toUpperCase()}`;
  // await db.booking.create({ ... })

  // 2. Send confirmation email (don't fail the booking if email fails).
  try {
    const result = await sendBookingEmail({
      to: recipient,
      type: "booking_confirmation",
      data: {
        bookingReference,
        passengerName: `${payload.first_name ?? ""} ${payload.last_name ?? ""}`.trim() || "Valued Customer",
        passengerEmail: recipient,
        pickupDate: payload.pickup_date,
        pickupTime: payload.pickup_time,
        pickupAddress: payload.pickup,
        dropoffAddress: payload.dropoff,
        vehicleType: payload.vehicle,
        passengers: payload.passengers,
        estimatedFare: payload.estimated_fare,
        paymentMethod: payload.payment_method,
        notes: payload.additional_note,
      },
    });
    console.log("[Book] email result:", result.success, result.messageId);
  } catch (err) {
    console.error("[Book] failed to send confirmation email:", err);
  }

  return NextResponse.json({ success: true, bookingReference }, { status: 201 });
}

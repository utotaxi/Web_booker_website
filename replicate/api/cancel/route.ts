/**
 * /api/cancel — example cancellation flow that sends a cancellation email.
 * Copy to src/app/api/cancel/route.ts (Next.js App Router).
 *
 * Pattern: update booking status to cancelled, then email the passenger.
 * If a refund is also being initiated, send "refund_requested" too (see
 * /api/refund) — or combine into one flow depending on your UX.
 */
import { NextRequest, NextResponse } from "next/server";
import { sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CancelPayload {
  bookingReference?: string;
  email?: string;
  passengerName?: string;
  cancellationReason?: string;
}

export async function POST(req: NextRequest) {
  const payload = (await req.json()) as CancelPayload;
  const recipient = payload.email?.trim();
  if (!recipient || !payload.bookingReference) {
    return NextResponse.json({ error: "bookingReference and email are required." }, { status: 400 });
  }

  // 1. Mark the booking as cancelled in your DB...
  // await db.booking.update({ where: { ref: payload.bookingReference }, data: { status: 'cancelled', cancellationReason } })

  // 2. Send the cancellation email.
  try {
    const result = await sendBookingEmail({
      to: recipient,
      type: "booking_cancelled",
      data: {
        bookingReference: payload.bookingReference,
        passengerName: payload.passengerName || "Customer",
        passengerEmail: recipient,
        cancellationReason: payload.cancellationReason || "Customer request",
      },
    });
    console.log("[Cancel] email result:", result.success, result.messageId);
  } catch (err) {
    console.error("[Cancel] failed to send cancellation email:", err);
  }

  return NextResponse.json({ success: true, status: "cancelled" });
}

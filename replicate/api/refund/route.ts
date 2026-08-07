/**
 * /api/refund — user requests a refund. Sends "refund_requested" email.
 * Copy to src/app/api/refund/route.ts (Next.js App Router).
 *
 * /api/refund/process (below) is the admin-side route that approves/rejects
 * a refund and sends "refund_approved" or "refund_rejected".
 */
import { NextRequest, NextResponse } from "next/server";
import { sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RefundRequestPayload {
  bookingReference?: string;
  email?: string;
  passengerName?: string;
  refundAmount?: number | string;
  refundReason?: string;     // why the customer wants a refund
}

export async function POST(req: NextRequest) {
  const payload = (await req.json()) as RefundRequestPayload;
  const recipient = payload.email?.trim();
  if (!recipient || !payload.bookingReference) {
    return NextResponse.json({ error: "bookingReference and email are required." }, { status: 400 });
  }

  const refundReference = `REFD-${Date.now().toString(36).toUpperCase()}`;

  // 1. Persist the refund request (status: 'requested') in your DB...
  // await db.refund.create({ bookingReference, refundReference, amount, reason, status: 'requested' })

  // 2. Email the customer confirming the request was received.
  try {
    const result = await sendBookingEmail({
      to: recipient,
      type: "refund_requested",
      data: {
        bookingReference: payload.bookingReference,
        passengerName: payload.passengerName || "Customer",
        passengerEmail: recipient,
        refundReference,
        refundAmount: payload.refundAmount,
        refundReason: payload.refundReason,
      },
    });
    console.log("[Refund] request email result:", result.success, result.messageId);
  } catch (err) {
    console.error("[Refund] failed to send request email:", err);
  }

  return NextResponse.json({ success: true, refundReference, status: "requested" }, { status: 201 });
}

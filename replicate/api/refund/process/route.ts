/**
 * /api/refund/process — admin approves or rejects a refund.
 * Copy to src/app/api/refund/process/route.ts (Next.js App Router).
 *
 * PROTECT THIS ROUTE — it should only be callable by an admin/agent.
 * (Add your auth/session/role check before processing.)
 *
 * Body: { bookingReference, email, passengerName, refundAmount,
 *         decision: 'approved' | 'rejected', refundMethod?, note? }
 *
 * Sends "refund_approved" or "refund_rejected" accordingly.
 * When decision === 'approved', also trigger the actual payment refund
 * with your payment provider (Stripe refund API, etc.) BEFORE emailing.
 */
import { NextRequest, NextResponse } from "next/server";
import { sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RefundDecisionPayload {
  bookingReference?: string;
  email?: string;
  passengerName?: string;
  refundAmount?: number | string;
  decision: "approved" | "rejected";
  refundMethod?: string;        // e.g. "Original payment method"
  note?: string;                // admin's reason/note
}

export async function POST(req: NextRequest) {
  // TODO: replace with your real admin auth check:
  // const session = await getServerSession(authOptions);
  // if (!session || session.user.role !== 'admin') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const payload = (await req.json()) as RefundDecisionPayload;
  const recipient = payload.email?.trim();
  if (!recipient || !payload.bookingReference || !payload.decision) {
    return NextResponse.json({ error: "bookingReference, email, and decision are required." }, { status: 400 });
  }

  // 1. If approved, issue the actual refund with your payment provider, e.g.:
  // if (payload.decision === 'approved') {
  //   await stripe.refunds.create({ payment_intent: intentId });
  // }

  // 2. Update the refund record status in your DB...
  // await db.refund.update({ where: { bookingReference }, data: { status: payload.decision, note: payload.note } })

  // 3. Email the customer with the decision.
  const type = payload.decision === "approved" ? "refund_approved" : "refund_rejected";
  try {
    const result = await sendBookingEmail({
      to: recipient,
      type,
      data: {
        bookingReference: payload.bookingReference,
        passengerName: payload.passengerName || "Customer",
        passengerEmail: recipient,
        refundAmount: payload.refundAmount,
        refundMethod: payload.refundMethod,
        refundDecisionReason: payload.note,
      },
    });
    console.log(`[Refund ${payload.decision}] email result:`, result.success, result.messageId);
  } catch (err) {
    console.error(`[Refund ${payload.decision}] failed to send email:`, err);
  }

  return NextResponse.json({ success: true, status: payload.decision });
}

/**
 * /api/email/test — copy to src/app/api/email/test/route.ts (Next.js App Router).
 *
 * - GET  /api/email/test       → verify SMTP connection (no email sent)
 * - POST /api/email/test {to}  → send a real test "booking_confirmation" email
 *
 * For Express: adapt to a router.get/post handler using req/res.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifySmtpConnection, sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await verifySmtpConnection();
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  let to = "test@example.com";
  try { const body = await req.json(); if (body?.to) to = body.to; } catch { /* use default */ }
  const result = await sendBookingEmail({
    to,
    type: "booking_confirmation",
    data: {
      bookingReference: `TEST-${Math.floor(100000 + Math.random() * 900000)}`,
      passengerName: "Test Passenger",
      passengerEmail: to,
      pickupDate: new Date().toISOString().split("T")[0],
      pickupTime: "14:30",
      pickupAddress: "Heathrow Airport",
      dropoffAddress: "Central London",
      vehicleType: "Saloon",
      passengers: 2,
      estimatedFare: "45.00",
      paymentMethod: "Card",
    },
  });
  return NextResponse.json(result, { status: result.success ? 200 : 500 });
}

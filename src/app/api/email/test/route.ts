import { NextRequest, NextResponse } from "next/server";
import { verifySmtpConnection, sendBookingEmail } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
    const verifyResult = await verifySmtpConnection();
    return NextResponse.json(verifyResult);
}

export async function POST(req: NextRequest) {
    try {
        let testEmail = "bookings@utotransfer.co.uk";
        try {
            const body = await req.json();
            if (body?.to) testEmail = body.to;
        } catch {
            // Use default test email if no body provided
        }

        const testData = {
            bookingReference: `UTO-TEST-${Math.floor(100000 + Math.random() * 900000)}`,
            passengerName: "Test Passenger",
            passengerEmail: testEmail,
            pickupDate: new Date().toISOString().split("T")[0],
            pickupTime: "14:30",
            pickupAddress: "Heathrow Airport Terminal 5, London TW6 2GA",
            dropoffAddress: "10 Downing Street, London SW1A 2AA",
            vehicleType: "Executive Saloon",
            passengers: 2,
            estimatedFare: "65.00",
            paymentMethod: "Credit Card (Stripe)",
            notes: "Test booking email configuration",
        };

        const sendResult = await sendBookingEmail({
            to: testEmail,
            type: "booking_confirmation",
            data: testData,
        });

        if (!sendResult.success) {
            return NextResponse.json(
                {
                    success: false,
                    error: sendResult.error,
                    details: sendResult.details,
                },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: `Test email sent successfully to ${testEmail}`,
            messageId: sendResult.messageId,
            sentFrom: "UTO Transfer <bookings@utotransfer.co.uk>",
        });
    } catch (err) {
        const error = err as Error;
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

import { NextRequest, NextResponse } from "next/server";
import { verifySmtpConnection, sendBookingEmail, type EmailType } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/email/test — Verify SMTP connection without sending an email.
 * Returns DNS resolution status, SMTP connectivity, and configuration details.
 */
export async function GET() {
    const verifyResult = await verifySmtpConnection();

    // Add config summary (mask password)
    const smtpUser = process.env.SMTP_USER || "bookings@utotransfer.co.uk";
    const smtpHost = process.env.SMTP_HOST || "smtp.gmail.com";
    const smtpPort = process.env.SMTP_PORT || "587";
    const hasPassword = !!(process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD);
    const hasResend = !!process.env.RESEND_API_KEY?.trim();

    return NextResponse.json({
        ...verifyResult,
        config: {
            host: smtpHost,
            port: parseInt(smtpPort, 10),
            user: smtpUser,
            hasAppPassword: hasPassword,
            provider: hasResend ? "resend" : "smtp",
        },
    });
}

/**
 * POST /api/email/test — Send a test booking confirmation email.
 * Body: { to?: string, type?: EmailType }
 * Default recipient: bookings@utotransfer.co.uk
 */
export async function POST(req: NextRequest) {
    try {
        let testEmail = "bookings@utotransfer.co.uk";
        let emailType: EmailType = "booking_confirmation";
        try {
            const body = await req.json();
            if (body?.to) testEmail = body.to;
            if (body?.type) emailType = body.type;
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
            notes: "Test booking — email configuration verification",
            driverName: "John Smith",
            driverPhone: "+44 7700 900000",
            vehicleModel: "Mercedes-Benz E-Class",
            vehiclePlate: "UTO 1234",
        };

        console.log(`[Email Test] Sending "${emailType}" test email to ${testEmail}`);

        const sendResult = await sendBookingEmail({
            to: testEmail,
            type: emailType,
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
            message: `Test email ("${emailType}") sent successfully to ${testEmail}`,
            messageId: sendResult.messageId,
            sentFrom: "UTO Transfer <bookings@utotransfer.co.uk>",
            details: sendResult.details,
        });
    } catch (err) {
        const error = err as Error;
        console.error("[Email Test API Error]", error);
        return NextResponse.json(
            { success: false, error: error.message },
            { status: 500 }
        );
    }
}

import { NextRequest, NextResponse } from "next/server";
import { sendBookingEmail, EmailType, BookingEmailData } from "@/lib/email-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SendEmailRequestBody {
    type: EmailType;
    to?: string;
    data: BookingEmailData;
}

export async function POST(req: NextRequest) {
    try {
        const body = (await req.json()) as SendEmailRequestBody;

        if (!body || !body.type || !body.data) {
            return NextResponse.json(
                { error: "Invalid payload. 'type' and 'data' are required." },
                { status: 400 }
            );
        }

        const targetEmail = body.to || body.data.passengerEmail;

        if (!targetEmail) {
            return NextResponse.json(
                { error: "Recipient email address is required ('to' or 'data.passengerEmail')." },
                { status: 400 }
            );
        }

        const result = await sendBookingEmail({
            to: targetEmail,
            type: body.type,
            data: body.data,
        });

        if (!result.success) {
            return NextResponse.json(
                { error: result.error || "Email failed to send", details: result.details },
                { status: 500 }
            );
        }

        return NextResponse.json({
            success: true,
            message: `Email (${body.type}) successfully delivered to ${targetEmail}.`,
            messageId: result.messageId,
            details: result.details,
        });
    } catch (err) {
        const error = err as Error;
        console.error("[API Email Send Error]", error);
        return NextResponse.json(
            { error: error.message || "Failed to process email sending request." },
            { status: 500 }
        );
    }
}

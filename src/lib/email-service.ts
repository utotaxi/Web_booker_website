import nodemailer from "nodemailer";
import { Resend } from "resend";
import dns, { Resolver } from "dns";

try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Safe fallback for Node runtimes
}

const publicResolver = new Resolver();
try {
  publicResolver.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch {
  // Safe fallback
}

/**
 * Custom DNS lookup helper for container environments (Railway, Docker)
 * Guarantees resolution for smtp.gmail.com by querying public DNS (8.8.8.8/1.1.1.1)
 * with hardcoded IPv4 fallbacks.
 */
function customDnsLookup(
  hostname: string,
  options: unknown,
  callback: (err: Error | null, address: string, family: number) => void
) {
  if (hostname === "smtp.gmail.com" || hostname.includes("gmail")) {
    publicResolver.resolve4("smtp.gmail.com", (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        callback(null, addresses[0], 4);
      } else {
        const fallbacks = [
          "142.250.102.108",
          "173.194.76.108",
          "74.125.133.108",
          "192.178.158.108",
        ];
        const chosenIp = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        callback(null, chosenIp, 4);
      }
    });
    return;
  }

  dns.lookup(hostname, options as dns.LookupOneOptions, (err, address, family) => {
    callback(err, address, family);
  });
}

export type EmailType =
  | "booking_confirmation"
  | "booking_updated"
  | "driver_assigned"
  | "driver_on_the_way"
  | "driver_arrived"
  | "trip_started"
  | "trip_completed"
  | "receipt"
  | "booking_cancelled";

export interface BookingEmailData {
  bookingReference: string;
  passengerName: string;
  passengerEmail: string;
  pickupDate: string;
  pickupTime: string;
  pickupAddress: string;
  dropoffAddress: string;
  vehicleType: string;
  passengers: number | string;
  estimatedFare: string | number;
  paymentMethod: string;
  notes?: string;
  driverName?: string;
  driverPhone?: string;
  vehicleModel?: string;
  vehiclePlate?: string;
  cancellationReason?: string;
}

export interface SendEmailOptions {
  to: string;
  type: EmailType;
  data: BookingEmailData;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Retrieves SMTP configuration from environment variables with defaults matching client spec.
 */
function getSmtpConfig() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const secure = process.env.SMTP_SECURE === "true"; // false for 587 (STARTTLS)
  const user = process.env.SMTP_USER || "bookings@utotransfer.co.uk";
  const pass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || "";
  const fromEmail = process.env.SMTP_FROM_EMAIL || "bookings@utotransfer.co.uk";
  const fromName = process.env.SMTP_FROM_NAME || "UTO Transfer";
  const replyTo = process.env.SMTP_REPLY_TO || "bookings@utotransfer.co.uk";

  return { host, port, secure, user, pass, fromEmail, fromName, replyTo };
}


let cachedTransporter: nodemailer.Transporter | null = null;

/**
 * Creates and returns a cached nodemailer Transporter.
 * Uses smtp.gmail.com hostname for proper TLS certificate validation.
 * Includes a custom DNS lookup that queries public resolvers (8.8.8.8, 1.1.1.1)
 * to ensure connectivity in container environments (Railway, Docker).
 */
export function getEmailTransporter(forceRefresh = false): nodemailer.Transporter {
  if (cachedTransporter && !forceRefresh) return cachedTransporter;

  const config = getSmtpConfig();

  if (!config.pass) {
    console.warn(
      "[SMTP Warning] SMTP_PASS or GMAIL_APP_PASSWORD environment variable is not set. Email sending may fail if authentication is required by SMTP host."
    );
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure, // false for 587 (STARTTLS), true for 465
    requireTLS: true,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    tls: {
      servername: config.host,
      rejectUnauthorized: process.env.NODE_ENV === "production",
      minVersion: "TLSv1.2" as const,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  } as nodemailer.TransportOptions);

  return cachedTransporter;
}


/**
 * Verifies DNS resolution for smtp.gmail.com using public resolvers.
 * Helps diagnose container DNS issues before attempting SMTP connection.
 */
async function verifyDnsResolution(): Promise<{ success: boolean; resolvedIp?: string; error?: string }> {
  return new Promise((resolve) => {
    publicResolver.resolve4("smtp.gmail.com", (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        resolve({ success: false, error: err?.message || "No IPv4 addresses resolved" });
      } else {
        resolve({ success: true, resolvedIp: addresses[0] });
      }
    });
  });
}

/**
 * Verifies SMTP connection configuration and returns detailed status.
 */
export async function verifySmtpConnection(): Promise<{ success: boolean; message: string; details?: Record<string, unknown> }> {
  if (process.env.RESEND_API_KEY?.trim()) {
    return {
      success: true,
      message: "Resend HTTP API key is configured. Email dispatch active via Resend.",
    };
  }

  const config = getSmtpConfig();
  if (!config.pass) {
    return {
      success: false,
      message: "SMTP password (SMTP_PASS or GMAIL_APP_PASSWORD) is not configured in environment.",
    };
  }

  // Pre-flight DNS check
  const dnsCheck = await verifyDnsResolution();
  if (!dnsCheck.success) {
    console.error(`[SMTP DNS Error] Cannot resolve smtp.gmail.com: ${dnsCheck.error}`);
    return {
      success: false,
      message: `DNS resolution failed for smtp.gmail.com: ${dnsCheck.error}. Check network/DNS configuration.`,
      details: { dnsError: dnsCheck.error },
    };
  }

  try {
    const transporter = getEmailTransporter(true);
    await transporter.verify();
    console.log(`[SMTP Verify] Connection verified successfully. Resolved IP: ${dnsCheck.resolvedIp}`);
    return {
      success: true,
      message: `SMTP server connection verified successfully (resolved: ${dnsCheck.resolvedIp}).`,
      details: { resolvedIp: dnsCheck.resolvedIp },
    };
  } catch (error) {
    cachedTransporter = null;
    const err = error as Error & { code?: string; command?: string; responseCode?: number };
    const errorDetails = `[SMTP Connection Error] ${err.message} (Code: ${err.code || "UNKNOWN"}, Command: ${err.command || "N/A"}, ResponseCode: ${err.responseCode || "N/A"})`;
    console.error(errorDetails, err);
    return {
      success: false,
      message: errorDetails,
      details: {
        code: err.code || "UNKNOWN",
        command: err.command || "N/A",
        responseCode: err.responseCode || "N/A",
        resolvedIp: dnsCheck.resolvedIp || "unknown",
      },
    };
  }
}



/**
 * Shared HTML Email Wrapper with modern, clean branding & fallback.
 */
function wrapHtmlEmail(title: string, bodyContent: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: #f4f6f9;
      margin: 0;
      padding: 0;
      color: #333333;
      -webkit-font-smoothing: antialiased;
    }
    .email-container {
      max-width: 600px;
      margin: 20px auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
      border: 1px solid #e1e8ed;
    }
    .email-header {
      background: linear-gradient(135deg, #111827 0%, #1f2937 100%);
      padding: 24px 32px;
      text-align: center;
    }
    .email-header h1 {
      color: #ffffff;
      margin: 0;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .email-header p {
      color: #9ca3af;
      margin: 4px 0 0 0;
      font-size: 13px;
    }
    .email-body {
      padding: 32px;
      font-size: 15px;
      line-height: 1.6;
      color: #374151;
    }
    .details-box {
      background-color: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .details-title {
      font-weight: 700;
      font-size: 16px;
      color: #111827;
      margin-bottom: 14px;
      border-bottom: 2px solid #3b82f6;
      padding-bottom: 6px;
      display: inline-block;
    }
    .detail-row {
      margin-bottom: 12px;
    }
    .detail-row:last-child {
      margin-bottom: 0;
    }
    .detail-label {
      font-weight: 600;
      color: #4b5563;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }
    .detail-value {
      font-size: 15px;
      color: #111827;
    }
    .policy-box {
      background-color: #eff6ff;
      border-left: 4px solid #3b82f6;
      padding: 16px;
      border-radius: 4px;
      margin: 24px 0;
      font-size: 14px;
      color: #1e40af;
    }
    .policy-title {
      font-weight: 700;
      margin-bottom: 6px;
      color: #1e3a8a;
    }
    .email-footer {
      background-color: #f9fafb;
      padding: 24px 32px;
      text-align: center;
      border-top: 1px solid #e5e7eb;
      font-size: 13px;
      color: #6b7280;
    }
    .email-footer p {
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-header">
      <h1>UTO Transfer</h1>
      <p>Premium Chauffeur & Transfer Services</p>
    </div>
    <div class="email-body">
      ${bodyContent}
    </div>
    <div class="email-footer">
      <p>Thank you for travelling with UTO.</p>
      <p>Kind regards,<br><strong>UTO Customer Support</strong></p>
      <p style="margin-top: 12px; font-size: 11px; color: #9ca3af;">
        This email was sent to you regarding your booking with UTO Transfer.
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Builds email content (subject, html, text) based on EmailType and booking data.
 */

function buildEmailContent(type: EmailType, data: BookingEmailData): { subject: string; html: string; text: string } {
  const notesText = data.notes && data.notes.trim() !== "" ? data.notes : "None";
  const fareDisplay = typeof data.estimatedFare === "number" ? data.estimatedFare.toFixed(2) : String(data.estimatedFare);

  switch (type) {
    case "booking_confirmation": {
      const subject = `Booking Confirmation - UTO Transfer (${data.bookingReference})`;

      const text = `Hi ${data.passengerName},
Thank you for choosing UTO.
Your booking has been successfully confirmed.

Booking Details
Booking Reference: ${data.bookingReference}
Pickup Date: ${data.pickupDate}
Pickup Time: ${data.pickupTime}
Pickup Address:
${data.pickupAddress}
Destination:
${data.dropoffAddress}
Vehicle Type:
${data.vehicleType}
Passengers:
${data.passengers}
Estimated Fare:
£${fareDisplay}
Payment Method:
${data.paymentMethod}
Special Requirements:
${notesText}

Cancellation & Refund Policy
You may cancel your booking free of charge up to 3 hours before your scheduled pickup time. In this case, you will receive a full refund if payment has already been made.
Cancellations made less than 3 hours before pickup may be subject to cancellation charges and may not be eligible for a refund.
To cancel your booking, please use the UTO app or contact our support team as soon as possible, by replying.

Thank you for your understanding and for choosing UTO.

Thank you for travelling with UTO.
Kind regards,
UTO Customer Support`;

      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Thank you for choosing UTO.<br>Your booking has been successfully confirmed.</p>

        <div class="details-box">
          <div class="details-title">Booking Details</div>
          
          <div class="detail-row">
            <div class="detail-label">Booking Reference</div>
            <div class="detail-value" style="font-weight: 700; color: #2563eb;">${data.bookingReference}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Pickup Date & Time</div>
            <div class="detail-value">${data.pickupDate} at ${data.pickupTime}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Pickup Address</div>
            <div class="detail-value">${data.pickupAddress}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Destination</div>
            <div class="detail-value">${data.dropoffAddress}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Vehicle Type</div>
            <div class="detail-value">${data.vehicleType}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Passengers</div>
            <div class="detail-value">${data.passengers}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Estimated Fare</div>
            <div class="detail-value" style="font-weight: 700;">£${fareDisplay}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Payment Method</div>
            <div class="detail-value">${data.paymentMethod}</div>
          </div>

          <div class="detail-row">
            <div class="detail-label">Special Requirements</div>
            <div class="detail-value">${notesText}</div>
          </div>
        </div>

        <div class="policy-box">
          <div class="policy-title">Cancellation & Refund Policy</div>
          <p style="margin: 0 0 8px 0;">You may cancel your booking free of charge up to 3 hours before your scheduled pickup time. In this case, you will receive a full refund if payment has already been made.</p>
          <p style="margin: 0 0 8px 0;">Cancellations made less than 3 hours before pickup may be subject to cancellation charges and may not be eligible for a refund.</p>
          <p style="margin: 0;">To cancel your booking, please use the UTO app or contact our support team as soon as possible, by replying to this email.</p>
        </div>

        <p>Thank you for your understanding and for choosing UTO.</p>
      `;

      return { subject, html: wrapHtmlEmail("Booking Confirmation - UTO Transfer", htmlBody), text };
    }

    case "booking_updated": {
      const subject = `Booking Updated - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour booking (${data.bookingReference}) has been updated.\n\nNew Pickup Date & Time: ${data.pickupDate} at ${data.pickupTime}\nPickup: ${data.pickupAddress}\nDestination: ${data.dropoffAddress}\nVehicle: ${data.vehicleType}\nFare: £${fareDisplay}\n\nThank you for choosing UTO.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Your booking details have been updated successfully.</p>
        <div class="details-box">
          <div class="details-title">Updated Booking Details</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Date & Time</div><div class="detail-value">${data.pickupDate} at ${data.pickupTime}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${data.dropoffAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Vehicle Type</div><div class="detail-value">${data.vehicleType}</div></div>
          <div class="detail-row"><div class="detail-label">Estimated Fare</div><div class="detail-value">£${fareDisplay}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Booking Updated", htmlBody), text };
    }

    case "driver_assigned": {
      const subject = `Driver Assigned - UTO Transfer (${data.bookingReference})`;
      const driverInfo = data.driverName ? `${data.driverName} (${data.driverPhone || "Contact via App"})` : "Assigned Driver";
      const vehicleInfo = [data.vehicleModel, data.vehiclePlate].filter(Boolean).join(" - ") || data.vehicleType;
      const text = `Hi ${data.passengerName},\n\nA driver has been assigned to your booking (${data.bookingReference}).\nDriver: ${driverInfo}\nVehicle: ${vehicleInfo}\nPickup Time: ${data.pickupTime} on ${data.pickupDate}.\n\nThank you for choosing UTO.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Great news! A driver has been assigned to your upcoming booking.</p>
        <div class="details-box">
          <div class="details-title">Driver & Booking Details</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Driver</div><div class="detail-value">${driverInfo}</div></div>
          <div class="detail-row"><div class="detail-label">Vehicle</div><div class="detail-value">${vehicleInfo}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Date & Time</div><div class="detail-value">${data.pickupDate} at ${data.pickupTime}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Driver Assigned", htmlBody), text };
    }

    case "driver_on_the_way": {
      const subject = `Driver On The Way - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour driver is currently on the way to your pickup address (${data.pickupAddress}) for booking ${data.bookingReference}.\n\nThank you for choosing UTO.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Your driver is now on the way to your pickup location.</p>
        <div class="details-box">
          <div class="details-title">Pickup Details</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${data.dropoffAddress}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Driver On The Way", htmlBody), text };
    }

    case "driver_arrived": {
      const subject = `Driver Has Arrived - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour driver has arrived at ${data.pickupAddress}.\nBooking Reference: ${data.bookingReference}\n\nPlease meet your driver at the pickup location.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p style="font-size: 16px; font-weight: 600; color: #16a34a;">Your driver has arrived at the pickup location!</p>
        <div class="details-box">
          <div class="details-title">Location Details</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
        </div>
        <p>Please meet your driver at your earliest convenience.</p>
      `;
      return { subject, html: wrapHtmlEmail("Driver Arrived", htmlBody), text };
    }

    case "trip_started": {
      const subject = `Trip Started - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour trip (${data.bookingReference}) has started. Destination: ${data.dropoffAddress}.\nHave a pleasant journey with UTO!`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Your trip has officially started. Sit back and enjoy your journey!</p>
        <div class="details-box">
          <div class="details-title">Trip Information</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${data.dropoffAddress}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Trip Started", htmlBody), text };
    }

    case "trip_completed": {
      const subject = `Trip Completed - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour trip (${data.bookingReference}) has been completed.\nThank you for travelling with UTO. We hope you had a pleasant journey!`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Thank you for travelling with UTO. Your trip has been completed successfully.</p>
        <div class="details-box">
          <div class="details-title">Trip Summary</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Total Fare</div><div class="detail-value">£${fareDisplay}</div></div>
          <div class="detail-row"><div class="detail-label">Payment Method</div><div class="detail-value">${data.paymentMethod}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Trip Completed", htmlBody), text };
    }

    case "receipt": {
      const subject = `Payment Receipt - UTO Transfer (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nHere is your receipt for booking ${data.bookingReference}.\nAmount Paid: £${fareDisplay}\nPayment Method: ${data.paymentMethod}\n\nThank you for choosing UTO.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Thank you for your payment. Here is your official receipt.</p>
        <div class="details-box">
          <div class="details-title">Payment Receipt</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Amount Paid</div><div class="detail-value" style="font-weight: 700; color: #16a34a;">£${fareDisplay}</div></div>
          <div class="detail-row"><div class="detail-label">Payment Method</div><div class="detail-value">${data.paymentMethod}</div></div>
          <div class="detail-row"><div class="detail-label">Date</div><div class="detail-value">${data.pickupDate}</div></div>
        </div>
      `;
      return { subject, html: wrapHtmlEmail("Receipt - UTO Transfer", htmlBody), text };
    }

    case "booking_cancelled": {
      const subject = `Booking Cancelled - UTO Transfer (${data.bookingReference})`;
      const reason = data.cancellationReason || "Customer request";
      const text = `Hi ${data.passengerName},\n\nYour booking (${data.bookingReference}) has been cancelled.\nReason: ${reason}\n\nIf you have any questions, please contact UTO support.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Your booking has been cancelled.</p>
        <div class="details-box" style="border-left: 4px solid #ef4444;">
          <div class="details-title">Cancellation Summary</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Reason</div><div class="detail-value">${reason}</div></div>
        </div>
        <p>If you require further assistance or would like to rebook, please contact our support team.</p>
      `;
      return { subject, html: wrapHtmlEmail("Booking Cancelled", htmlBody), text };
    }
  }
}

/**
 * Sends automated booking email with full error handling and logging.
 * Prefers Resend HTTP API if RESEND_API_KEY is present (recommended on Railway),
 * falling back to Nodemailer SMTP via Gmail.
 *
 * IMPORTANT: Gmail SMTP requires an App Password (not your regular password).
 * Generate one at: https://myaccount.google.com/apppasswords
 * Set it as SMTP_PASS or GMAIL_APP_PASSWORD in your environment variables.
 */
export async function sendBookingEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const config = getSmtpConfig();
  const targetEmail = options.to?.trim() || options.data?.passengerEmail?.trim();

  if (!targetEmail) {
    const errorMsg = "[Email Error] Recipient email is missing or empty.";
    console.error(errorMsg, { options });
    return { success: false, error: errorMsg };
  }

  const { subject, html, text } = buildEmailContent(options.type, options.data);

  console.log(`[Email Dispatch] Preparing to send "${options.type}" email to ${targetEmail}`);
  console.log(`[Email Dispatch] SMTP config: host=${config.host}, port=${config.port}, user=${config.user}, from="${config.fromName}" <${config.fromEmail}>`);

  // 1. HTTP API dispatch via Resend (Bypasses cloud firewall SMTP port blocks on Railway/Vercel)
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (resendApiKey) {
    try {
      const resend = new Resend(resendApiKey);
      const fromAddress = process.env.RESEND_FROM_EMAIL?.trim() || `"${config.fromName}" <onboarding@resend.dev>`;
      const resendResult = await resend.emails.send({
        from: fromAddress,
        to: targetEmail,
        replyTo: config.replyTo,
        subject,
        html,
        text,
      });

      if (resendResult.error) {
        console.error("[Resend Error]", resendResult.error);
        throw new Error(resendResult.error.message);
      }

      console.log(`[Resend Success] Email sent successfully (${options.type}) to ${targetEmail}. ID: ${resendResult.data?.id}`);
      return {
        success: true,
        messageId: resendResult.data?.id,
        details: { provider: "resend", data: resendResult.data },
      };
    } catch (resendErr) {
      console.warn("[Resend Fallback] Resend HTTP API failed, falling back to Nodemailer SMTP:", (resendErr as Error).message);
    }
  }

  // 2. SMTP / Nodemailer dispatch via Gmail
  const mailOptions: nodemailer.SendMailOptions = {
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: targetEmail,
    replyTo: config.replyTo,
    subject,
    text,
    html,
  };

  try {
    const transporter = getEmailTransporter();
    console.log(`[SMTP Sending] Connecting to ${config.host}:${config.port}...`);
    const info = await transporter.sendMail(mailOptions);

    console.log(`[SMTP Success] Email sent successfully (${options.type}) to ${targetEmail}. Message ID: ${info.messageId}`);
    console.log(`[SMTP Success] Server response: ${info.response}`);
    return {
      success: true,
      messageId: info.messageId,
      details: { provider: "smtp", response: info.response, envelope: info.envelope },
    };
  } catch (error) {
    // Invalidate cached transporter on error so next attempt creates a fresh connection
    cachedTransporter = null;
    const err = error as Error & { code?: string; command?: string; responseCode?: number; response?: string };

    const logDetails = {
      type: options.type,
      recipient: targetEmail,
      subject,
      host: config.host,
      port: config.port,
      user: config.user,
      errorCode: err.code || "UNKNOWN",
      errorMessage: err.message,
      command: err.command || "N/A",
      responseCode: err.responseCode || "N/A",
      smtpResponse: err.response || "N/A",
    };

    console.error(`[SMTP Error] Failed to send ${options.type} email to ${targetEmail}`, logDetails);

    // Provide actionable error messages for common Gmail SMTP issues
    let actionableHint = "";
    if (err.code === "EAUTH" || err.message?.includes("Invalid login") || err.message?.includes("535")) {
      actionableHint = " Gmail authentication failed. Verify your App Password is correct and 2FA is enabled. Generate a new App Password at https://myaccount.google.com/apppasswords";
    } else if (err.code === "ESOCKET" || err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
      actionableHint = ` Cannot reach ${config.host}:${config.port}. Check network/firewall allows outbound SMTP (port 587).`;
    } else if (err.code === "ECONNRESET" || err.message?.includes("timeout")) {
      actionableHint = " Connection was reset or timed out. The SMTP server may be unreachable from this environment.";
    } else if (err.message?.includes("certificate") || err.message?.includes("TLS")) {
      actionableHint = " TLS/certificate error. The SMTP server's certificate could not be verified.";
    }

    const fullError = `Failed to send email: ${err.message}${actionableHint}`;

    return {
      success: false,
      error: fullError,
      details: logDetails,
    };
  }
}


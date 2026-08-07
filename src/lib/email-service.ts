import nodemailer from "nodemailer";
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
  | "booking_reminder"
  | "driver_assigned"
  | "driver_on_the_way"
  | "driver_arrived"
  | "trip_started"
  | "trip_completed"
  | "receipt"
  | "booking_cancelled"
  | "driver_reminder";

export interface DriverBookingItem {
  bookingReference: string;
  passengerName: string;
  pickupDate: string; // DD/MM/YYYY
  pickupTime: string; // HH:MM (24h)
  pickupAddress: string;
  dropoffAddress: string;
  vehicleType: string;
  estimatedFare: string;
  notes?: string;
}

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
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColour?: string;
  vehiclePlate?: string;
  vehicleRegistration?: string;
  eta?: string;
  reminderWindow?: string;
  cancellationReason?: string;
  /** All of the driver's accepted upcoming bookings — used by driver_reminder. */
  driverUpcomingBookings?: DriverBookingItem[];
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
 * Support contact shown to passengers in transactional emails. Override at
 * deploy time via UTO_SUPPORT_PHONE if the number ever changes.
 */
const UTO_SUPPORT_PHONE = process.env.UTO_SUPPORT_PHONE?.trim() || "07596266901";
const UTO_WEBSITE = process.env.UTO_WEBSITE?.trim() || "www.utotransfer.co.uk";

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
let cachedResolvedIp: string | null = null;

/**
 * Resolves smtp.gmail.com via public DNS resolvers (8.8.8.8, 1.1.1.1).
 * Needed for container environments (Railway) where the default DNS cannot
 * resolve external SMTP hostnames. Returns the resolved IP or a fallback.
 */
async function resolveSmtpIp(host: string): Promise<string> {
  if (host !== "smtp.gmail.com" && !host.includes("gmail")) {
    return host; // Non-Gmail host, use as-is
  }

  return new Promise((resolve) => {
    publicResolver.resolve4("smtp.gmail.com", (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        console.log(`[SMTP DNS] Resolved smtp.gmail.com → ${addresses[0]} (via public DNS)`);
        resolve(addresses[0]);
      } else {
        // Fallback IPs — dynamically resolved ones rotate, these are stable backups
        const fallbacks = [
          "142.250.102.109",
          "173.194.76.108",
          "74.125.133.108",
          "192.178.158.109",
        ];
        const chosenIp = fallbacks[Math.floor(Math.random() * fallbacks.length)];
        console.warn(`[SMTP DNS] Public DNS failed (${err?.message || "no addresses"}), using fallback IP: ${chosenIp}`);
        resolve(chosenIp);
      }
    });
  });
}

/**
 * Creates and returns a cached nodemailer Transporter.
 *
 * On Railway/container environments, the runtime DNS may fail to resolve
 * smtp.gmail.com. We pre-resolve the IP via public DNS (8.8.8.8/1.1.1.1),
 * connect to that IP, and set servername for proper TLS SNI so Gmail's
 * certificate still validates against "smtp.gmail.com".
 */
export async function getEmailTransporter(forceRefresh = false): Promise<nodemailer.Transporter> {
  if (cachedTransporter && !forceRefresh && cachedResolvedIp) return cachedTransporter;

  const config = getSmtpConfig();

  if (!config.pass) {
    console.warn(
      "[SMTP Warning] SMTP_PASS or GMAIL_APP_PASSWORD environment variable is not set. Email sending may fail if authentication is required by SMTP host."
    );
  }

  // Resolve IP via public DNS before creating transporter (Railway DNS workaround)
  const resolvedIp = await resolveSmtpIp(config.host);
  cachedResolvedIp = resolvedIp;

  const isGmail = config.host === "smtp.gmail.com" || config.host.includes("gmail");

  cachedTransporter = nodemailer.createTransport({
    host: resolvedIp, // Use resolved IP to bypass broken container DNS
    port: config.port,
    secure: config.secure, // false for 587 (STARTTLS)
    requireTLS: true,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    tls: {
      // SNI with the real hostname so Gmail's TLS cert matches
      servername: isGmail ? "smtp.gmail.com" : config.host,
      // Must be false when connecting via IP — the cert is issued to the hostname, not the IP
      rejectUnauthorized: false,
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
    const transporter = await getEmailTransporter(true);
    await transporter.verify();
    console.log(`[SMTP Verify] Connection verified successfully. Resolved IP: ${dnsCheck.resolvedIp}`);
    return {
      success: true,
      message: `SMTP server connection verified successfully (resolved: ${dnsCheck.resolvedIp}).`,
      details: { resolvedIp: dnsCheck.resolvedIp },
    };
  } catch (error) {
    cachedTransporter = null;
    cachedResolvedIp = null;
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
      <h1>UTO</h1>
      <p>Reliable transfers, anytime.</p>
    </div>
    <div class="email-body">
      ${bodyContent}
    </div>
    <div class="email-footer">
      <p>Thank you for travelling with UTO.</p>
      <p>Kind regards,<br><strong>UTO Customer Support</strong></p>
      <p style="margin-top: 12px; font-size: 11px; color: #9ca3af;">
        This email was sent to you regarding your booking with UTO.
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
      const driverName = data.driverName?.trim() || "Your assigned driver";
      const vehicleMake = data.vehicleMake?.trim() || "";
      const vehicleModel = data.vehicleModel?.trim() || "";
      const vehicleColour = data.vehicleColour?.trim() || "";
      // Prefer vehicleRegistration; fall back to vehiclePlate for older callers.
      const registration =
        data.vehicleRegistration?.trim() || data.vehiclePlate?.trim() || "";
      const driverPhone = data.driverPhone?.trim() || "";
      const vehicleLine = [vehicleMake, vehicleModel].filter(Boolean).join(" ") || data.vehicleType;

      const text = `Hi ${data.passengerName},

Good news! Your driver has now been assigned.

Driver Details
Driver Name: ${driverName}
Vehicle: ${vehicleLine}${vehicleColour ? `\nVehicle Colour: ${vehicleColour}` : ""}${registration ? `\nRegistration: ${registration}` : ""}${driverPhone ? `\nDriver Phone: ${driverPhone}` : ""}
Pickup Time: ${data.pickupDate} at ${data.pickupTime}
Pickup Address: ${data.pickupAddress}
Destination: ${data.dropoffAddress}

If you have any difficulty locating your driver, please contact them directly or call our support team on ${UTO_SUPPORT_PHONE}.

Journey Changes
If you would like to make any changes to your journey after your driver has been assigned (including adding additional stops, changing the destination, or requesting a different route), please discuss these with your driver before the journey commences.
Any changes to the original booking are subject to the driver's agreement and may not always be possible due to scheduling or other commitments.
Please note that additional charges may apply for any extra distance, waiting time, or changes to your booked journey. Any additional fare will be calculated based on the updated trip details.

We wish you a pleasant journey.
Thank you for choosing UTO.`;

      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>Good news! Your driver has now been assigned.</p>
        <div class="details-box">
          <div class="details-title">Driver Details</div>
          <div class="detail-row"><div class="detail-label">Driver Name</div><div class="detail-value">${driverName}</div></div>
          <div class="detail-row"><div class="detail-label">Vehicle</div><div class="detail-value">${vehicleLine}</div></div>
          ${vehicleColour ? `<div class="detail-row"><div class="detail-label">Vehicle Colour</div><div class="detail-value">${vehicleColour}</div></div>` : ""}
          ${registration ? `<div class="detail-row"><div class="detail-label">Registration</div><div class="detail-value">${registration}</div></div>` : ""}
          ${driverPhone ? `<div class="detail-row"><div class="detail-label">Driver Phone</div><div class="detail-value">${driverPhone}</div></div>` : ""}
          <div class="detail-row"><div class="detail-label">Pickup Time</div><div class="detail-value">${data.pickupDate} at ${data.pickupTime}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${data.dropoffAddress}</div></div>
        </div>
        <p>If you have any difficulty locating your driver, please contact them directly or call our support team on <strong>${UTO_SUPPORT_PHONE}</strong>.</p>
        <div class="policy-box">
          <div class="policy-title">Journey Changes</div>
          <p style="margin: 0 0 8px 0;">If you would like to make any changes to your journey after your driver has been assigned (including adding additional stops, changing the destination, or requesting a different route), please discuss these with your driver before the journey commences.</p>
          <p style="margin: 0 0 8px 0;">Any changes to the original booking are subject to the driver's agreement and may not always be possible due to scheduling or other commitments.</p>
          <p style="margin: 0;">Please note that additional charges may apply for any extra distance, waiting time, or changes to your booked journey. Any additional fare will be calculated based on the updated trip details.</p>
        </div>
        <p>We wish you a pleasant journey.<br>Thank you for choosing UTO.</p>
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

    case "booking_reminder": {
      const windowLabel = data.reminderWindow?.trim() || "soon";
      const subject = `Reminder: Your UTO Transfer ${windowLabel} (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nThis is a reminder for your upcoming booking (${data.bookingReference}) scheduled ${windowLabel}.\nPickup: ${data.pickupDate} at ${data.pickupTime}\nFrom: ${data.pickupAddress}\nTo: ${data.dropoffAddress}\nVehicle: ${data.vehicleType}\nEstimated Fare: £${fareDisplay}\nPayment Method: ${data.paymentMethod}\n\nThank you for choosing UTO Transfer.`;
      const htmlBody = `
        <p>Hi ${data.passengerName},</p>
        <p>This is a friendly reminder for your upcoming booking scheduled <strong>${windowLabel}</strong>.</p>
        <div class="details-box">
          <div class="details-title">Booking Reminder</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${data.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Date & Time</div><div class="detail-value">${data.pickupDate} at ${data.pickupTime}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${data.pickupAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${data.dropoffAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Vehicle Type</div><div class="detail-value">${data.vehicleType}</div></div>
          <div class="detail-row"><div class="detail-label">Estimated Fare</div><div class="detail-value">£${fareDisplay}</div></div>
          <div class="detail-row"><div class="detail-label">Payment Method</div><div class="detail-value">${data.paymentMethod}</div></div>
        </div>
        <p>We look forward to seeing you. If you need to make changes, please contact UTO support.</p>
      `;
      return { subject, html: wrapHtmlEmail("Booking Reminder", htmlBody), text };
    }

    case "driver_reminder": {
      const bookings = data.driverUpcomingBookings ?? [];
      const count = bookings.length;
      const subject = `Your Upcoming UTO Bookings (${count}) — Driver Reminder`;
      const windowLabel = data.reminderWindow?.trim();

      const bookingBlocks = bookings
        .map((b, i) => {
          const fare = b.estimatedFare || "0.00";
          const notes = b.notes?.trim() ? b.notes.trim() : "None";
          const text = `Booking ${i + 1} of ${count}
Booking Reference: ${b.bookingReference}
Pickup Date: ${b.pickupDate}
Pickup Time: ${b.pickupTime}
Passenger: ${b.passengerName}
Pickup Address: ${b.pickupAddress}
Destination: ${b.dropoffAddress}
Vehicle Required: ${b.vehicleType}
Estimated Fare: £${fare}
Special Instructions: ${notes}`;
          const html = `
        <div class="details-box">
          <div class="details-title">Booking ${i + 1} of ${count}</div>
          <div class="detail-row"><div class="detail-label">Booking Reference</div><div class="detail-value">${b.bookingReference}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Date</div><div class="detail-value">${b.pickupDate}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Time</div><div class="detail-value">${b.pickupTime}</div></div>
          <div class="detail-row"><div class="detail-label">Passenger</div><div class="detail-value">${b.passengerName}</div></div>
          <div class="detail-row"><div class="detail-label">Pickup Address</div><div class="detail-value">${b.pickupAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Destination</div><div class="detail-value">${b.dropoffAddress}</div></div>
          <div class="detail-row"><div class="detail-label">Vehicle Required</div><div class="detail-value">${b.vehicleType}</div></div>
          <div class="detail-row"><div class="detail-label">Estimated Fare</div><div class="detail-value">£${fare}</div></div>
          <div class="detail-row"><div class="detail-label">Special Instructions</div><div class="detail-value">${notes}</div></div>
        </div>`;
          return { text, html };
        });

      const textList = bookingBlocks.map((b) => b.text).join("\n\n");
      const htmlList = bookingBlocks.map((b) => b.html).join("");

      const text = `Hi ${data.driverName || "Driver"},${windowLabel ? `\nThis is a ${windowLabel} reminder about your upcoming bookings with UTO.` : "\nThis is a friendly reminder about your upcoming bookings with UTO."} You have ${count} accepted booking${count === 1 ? "" : "s"}.

${textList}

Driver Responsibilities
Please ensure you get in contact with the passenger, arrive at the pickup location on time, with your vehicle clean, roadworthy, and ready to provide a safe and professional service.
If you anticipate any issue that may affect your ability to complete this booking, please notify UTO immediately. Where appropriate, you should also keep the passenger informed of any delays or circumstances affecting the journey.

Cancellation Policy
We value a reliable partnership with all of our drivers and appreciate your commitment to providing an excellent service.
If you need to cancel an accepted booking, please do so as early as possible. If a driver cancels a booking less than 3 hours before the scheduled pickup time, the driver will be responsible for 50% of the estimated trip value, unless the cancellation is due to exceptional circumstances approved by UTO.
This policy helps protect our passengers, who may struggle to find alternative transport at short notice, and supports a fair and dependable service for everyone.

Thank you for your professionalism and for being part of the UTO driver network. We look forward to building a long-term, reliable partnership together.

Kind regards,
UTO Driver Support
${UTO_SUPPORT_PHONE}
${UTO_WEBSITE}`;

      const htmlBody = `
        <p>Hi ${data.driverName || "Driver"},</p>
        <p>${windowLabel ? `This is a <strong>${windowLabel}</strong> reminder about your upcoming bookings with UTO.` : "This is a friendly reminder about your upcoming bookings with UTO."} You have <strong>${count}</strong> accepted booking${count === 1 ? "" : "s"}.</p>
        ${htmlList}
        <div class="policy-box">
          <div class="policy-title">Driver Responsibilities</div>
          <p style="margin:0 0 8px 0;">Please ensure you get in contact with the passenger, arrive at the pickup location on time, with your vehicle clean, roadworthy, and ready to provide a safe and professional service.</p>
          <p style="margin:0;">If you anticipate any issue that may affect your ability to complete this booking, please notify UTO immediately. Where appropriate, you should also keep the passenger informed of any delays or circumstances affecting the journey.</p>
        </div>
        <div class="policy-box" style="border-left-color:#ef4444;background-color:#fef2f2;color:#7f1d1d;">
          <div class="policy-title" style="color:#991b1b;">Cancellation Policy</div>
          <p style="margin:0 0 8px 0;">We value a reliable partnership with all of our drivers and appreciate your commitment to providing an excellent service.</p>
          <p style="margin:0 0 8px 0;">If you need to cancel an accepted booking, please do so as early as possible. If a driver cancels a booking less than 3 hours before the scheduled pickup time, the driver will be responsible for 50% of the estimated trip value, unless the cancellation is due to exceptional circumstances approved by UTO.</p>
          <p style="margin:0;">This policy helps protect our passengers, who may struggle to find alternative transport at short notice, and supports a fair and dependable service for everyone.</p>
        </div>
        <p>Thank you for your professionalism and for being part of the UTO driver network. We look forward to building a long-term, reliable partnership together.</p>
        <p>Kind regards,<br><strong>UTO Driver Support</strong><br>📞 ${UTO_SUPPORT_PHONE}<br>🌐 ${UTO_WEBSITE}</p>
      `;
      return { subject, html: wrapHtmlEmail("Driver Booking Reminder", htmlBody), text };
    }

    default: {
      // Exhaustiveness guard: if a new EmailType is added without a matching
      // case here, this throws a clear error instead of returning undefined and
      // crashing the caller's destructuring silently.
      const exhaustive: never = type;
      throw new Error(`[Email Service] Unsupported email type: ${exhaustive}`);
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

  // // 1. HTTP API dispatch via Resend (Bypasses cloud firewall SMTP port blocks on Railway/Vercel)
  // const resendApiKey = process.env.RESEND_API_KEY?.trim();
  // if (resendApiKey) {
  //   try {
  //     const resend = new Resend(resendApiKey);
  //     const fromAddress = process.env.RESEND_FROM_EMAIL?.trim() || `"${config.fromName}" <onboarding@resend.dev>`;
  //     const resendResult = await resend.emails.send({
  //       from: fromAddress,
  //       to: targetEmail,
  //       replyTo: config.replyTo,
  //       subject,
  //       html,
  //       text,
  //     });

  //     if (resendResult.error) {
  //       console.error("[Resend Error]", resendResult.error);
  //       throw new Error(resendResult.error.message);
  //     }

  //     console.log(`[Resend Success] Email sent successfully (${options.type}) to ${targetEmail}. ID: ${resendResult.data?.id}`);
  //     return {
  //       success: true,
  //       messageId: resendResult.data?.id,
  //       details: { provider: "resend", data: resendResult.data },
  //     };
  //   } catch (resendErr) {
  //     console.warn("[Resend Fallback] Resend HTTP API failed, falling back to Nodemailer SMTP:", (resendErr as Error).message);
  //   }
  // }

  // 2. SMTP / Nodemailer dispatch via Gmail
  // Try port 587 (STARTTLS) first, fall back to port 465 (SSL) on timeout/refused.
  // Railway blocks outbound SMTP ports, so this may still fail — see Resend option above.
  const portsToTry = config.port === 587 ? [587, 465] : [config.port, 587, 465];

  const mailOptions: nodemailer.SendMailOptions = {
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: targetEmail,
    replyTo: config.replyTo,
    subject,
    text,
    html,
  };

  let lastError: Error & { code?: string; command?: string; responseCode?: number; response?: string } | null = null;

  for (const tryPort of portsToTry) {
    const isSecure = tryPort === 465;
    try {
      // Force-fresh transporter per port attempt
      cachedTransporter = null;
      cachedResolvedIp = null;
      const transporter = await getEmailTransporter(true);
      console.log(`[SMTP Sending] Trying ${config.host}:${tryPort} (secure=${isSecure})...`);
      const info = await transporter.sendMail(mailOptions);

      console.log(`[SMTP Success] Email sent successfully (${options.type}) to ${targetEmail}. Message ID: ${info.messageId}`);
      console.log(`[SMTP Success] Server response: ${info.response}`);
      return {
        success: true,
        messageId: info.messageId,
        details: { provider: "smtp", response: info.response, envelope: info.envelope },
      };
    } catch (error) {
      // Invalidate cached transporter on error so the next port attempt creates
      // a fresh connection. Don't return here — fall through to the next port
      // so the 465 (SSL) fallback actually runs.
      cachedTransporter = null;
      cachedResolvedIp = null;
      lastError = error as Error & { code?: string; command?: string; responseCode?: number; response?: string };
      console.warn(
        `[SMTP Error] ${config.host}:${tryPort} failed for ${options.type} to ${targetEmail}: ${lastError.code || "UNKNOWN"} ${lastError.message}`
      );
    }
  }

  // All ports failed (or none were configured). Build a single actionable error.
  const err: Error & { code?: string; command?: string; responseCode?: number; response?: string } =
    lastError ?? new Error("No SMTP ports were configured to try.");
  const logDetails = {
    type: options.type,
    recipient: targetEmail,
    subject,
    host: config.host,
    portsTried: portsToTry,
    user: config.user,
    errorCode: err.code || "UNKNOWN",
    errorMessage: err.message,
    command: err.command || "N/A",
    responseCode: err.responseCode || "N/A",
    smtpResponse: err.response || "N/A",
  };

  console.error(`[SMTP Error] All ports failed to send ${options.type} email to ${targetEmail}`, logDetails);

  let actionableHint = "";
  if (err.code === "EAUTH" || err.message?.includes("Invalid login") || err.message?.includes("535")) {
    actionableHint = " Gmail authentication failed. Verify your App Password is correct and 2FA is enabled. Generate a new App Password at https://myaccount.google.com/apppasswords";
  } else if (err.code === "ESOCKET" || err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
    actionableHint = ` Cannot reach ${config.host}. Check network/firewall allows outbound SMTP (ports 587/465).`;
  } else if (err.code === "ECONNRESET" || err.message?.includes("timeout")) {
    actionableHint = " Connection was reset or timed out. The SMTP server may be unreachable from this environment.";
  } else if (err.message?.includes("certificate") || err.message?.includes("TLS")) {
    actionableHint = " TLS/certificate error. The SMTP server's certificate could not be verified.";
  }

  const fullError = `Failed to send email via SMTP ports (${portsToTry.join(", ")}): ${err.message}${actionableHint}`;

  return {
    success: false,
    error: fullError,
    details: logDetails,
  };
}
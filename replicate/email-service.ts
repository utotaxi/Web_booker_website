/**
 * email-service.ts — Self-contained SMTP email service.
 *
 * Drop this into your app (e.g. src/lib/email-service.ts). Framework-agnostic:
 * it's a plain Node/TypeScript module using Nodemailer. It works in Next.js
 * API routes, Express, Fastify, or any Node runtime.
 *
 * Sends via Nodemailer SMTP using a Gmail App Password. Includes a public-DNS
 * resolver workaround for container hosts (Fly.io, Docker) where the runtime
 * DNS sometimes can't resolve smtp.gmail.com.
 *
 * NOTE on hosts: Railway/Vercel/Netlify BLOCK outbound SMTP ports 587/465.
 * Use a host that allows outbound SMTP (Fly.io, a VPS, Render paid, Cloud Run).
 *
 * Email types: booking_confirmation, booking_cancelled,
 *              refund_requested, refund_approved, refund_rejected
 */

import nodemailer from "nodemailer";
import dns, { Resolver } from "dns";

// ─── Branding (edit, or drive from env) ────────────────────────────────
const BRAND_NAME = process.env.BRAND_NAME || "UTO Transfer";
const SUPPORT_EMAIL = process.env.BRAND_SUPPORT_EMAIL || "support@utotransfer.co.uk";

// ─── Public-DNS resolver (container workaround) ────────────────────────
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  /* safe fallback */
}

const publicResolver = new Resolver();
try {
  publicResolver.setServers(["8.8.8.8", "1.1.1.1", "8.8.4.4"]);
} catch {
  /* safe fallback */
}

async function resolveSmtpIp(host: string): Promise<string> {
  if (host !== "smtp.gmail.com" && !host.includes("gmail")) return host;
  return new Promise((resolve) => {
    publicResolver.resolve4("smtp.gmail.com", (err, addresses) => {
      if (!err && addresses && addresses.length > 0) {
        resolve(addresses[0]);
      } else {
        // Stable fallback IPs (rotate periodically; these are backups).
        const fallbacks = ["142.250.102.109", "173.194.76.108", "74.125.133.108", "192.178.158.109"];
        resolve(fallbacks[Math.floor(Math.random() * fallbacks.length)]);
      }
    });
  });
}

// ─── Types ─────────────────────────────────────────────────────────────
export type EmailType =
  | "booking_confirmation"
  | "booking_cancelled"
  | "refund_requested"
  | "refund_approved"
  | "refund_rejected";

export interface BookingEmailData {
  bookingReference: string;
  passengerName: string;
  passengerEmail: string;
  pickupDate?: string;
  pickupTime?: string;
  pickupAddress?: string;
  dropoffAddress?: string;
  vehicleType?: string;
  passengers?: number | string;
  estimatedFare?: string | number;
  paymentMethod?: string;
  notes?: string;
  // Cancellation / refund fields:
  cancellationReason?: string;
  refundAmount?: string | number;
  refundReason?: string;        // user-supplied reason for requesting a refund
  refundReference?: string;     // e.g. REFD-XXXXXX
  refundMethod?: string;        // "Original payment method" / "Bank transfer"
  refundDecisionReason?: string;// admin reason when approving/rejecting
  adminContact?: string;
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

// ─── SMTP config from env ──────────────────────────────────────────────
function getSmtpConfig() {
  const host = (process.env.SMTP_HOST || "smtp.gmail.com").trim();
  const port = parseInt((process.env.SMTP_PORT || "587").trim(), 10);
  const secure = process.env.SMTP_SECURE?.trim() === "true";
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || "";
  const fromEmail = process.env.SMTP_FROM_EMAIL || user;
  const fromName = process.env.SMTP_FROM_NAME || BRAND_NAME;
  const replyTo = process.env.SMTP_REPLY_TO || fromEmail;
  return { host, port, secure, user, pass, fromEmail, fromName, replyTo };
}

let cachedTransporter: nodemailer.Transporter | null = null;
let cachedResolvedIp: string | null = null;

export async function getEmailTransporter(forceRefresh = false, portOverride?: number): Promise<nodemailer.Transporter> {
  if (cachedTransporter && !forceRefresh && !portOverride) return cachedTransporter;
  const config = getSmtpConfig();
  if (!config.pass) {
    console.warn("[SMTP] SMTP_PASS / GMAIL_APP_PASSWORD not set — auth may fail.");
  }
  const resolvedIp = await resolveSmtpIp(config.host);
  cachedResolvedIp = resolvedIp;
  const isGmail = config.host === "smtp.gmail.com" || config.host.includes("gmail");
  const effectivePort = portOverride ?? config.port;
  const effectiveSecure = effectivePort === 465;
  cachedTransporter = nodemailer.createTransport({
    host: resolvedIp,
    port: effectivePort,
    secure: effectiveSecure,
    requireTLS: effectivePort !== 465,
    auth: config.user && config.pass ? { user: config.user, pass: config.pass } : undefined,
    tls: {
      servername: isGmail ? "smtp.gmail.com" : config.host,
      rejectUnauthorized: false, // connecting via IP; cert is issued to hostname
      minVersion: "TLSv1.2" as const,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  } as nodemailer.TransportOptions);
  return cachedTransporter;
}

async function verifyDnsResolution() {
  return new Promise<{ success: boolean; resolvedIp?: string; error?: string }>((resolve) => {
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
 * Verify SMTP connectivity without sending. Hit this from a health/test route.
 */
export async function verifySmtpConnection(): Promise<{ success: boolean; message: string; details?: Record<string, unknown> }> {
  const config = getSmtpConfig();
  if (!config.pass) {
    return { success: false, message: "SMTP_PASS / GMAIL_APP_PASSWORD is not configured." };
  }
  const dnsCheck = await verifyDnsResolution();
  if (!dnsCheck.success) {
    return { success: false, message: `DNS resolution failed for smtp.gmail.com: ${dnsCheck.error}`, details: { dnsError: dnsCheck.error } };
  }
  try {
    const transporter = await getEmailTransporter(true);
    await transporter.verify();
    return { success: true, message: `SMTP connection verified (resolved: ${dnsCheck.resolvedIp}).`, details: { resolvedIp: dnsCheck.resolvedIp } };
  } catch (error) {
    cachedTransporter = null;
    cachedResolvedIp = null;
    const err = error as Error & { code?: string; command?: string; responseCode?: number };
    return {
      success: false,
      message: `[SMTP Error] ${err.message} (Code: ${err.code || "UNKNOWN"}, Command: ${err.command || "N/A"})`,
      details: { code: err.code || "UNKNOWN", resolvedIp: dnsCheck.resolvedIp },
    };
  }
}

// ─── HTML wrapper ───────────────────────────────────────────────────────
function wrapHtmlEmail(title: string, bodyContent: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f4f6f9;margin:0;padding:0;color:#333}
  .container{max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.08);border:1px solid #e1e8ed}
  .header{background:linear-gradient(135deg,#111827,#1f2937);padding:24px 32px;text-align:center}
  .header h1{color:#fff;margin:0;font-size:22px;font-weight:700}
  .body{padding:32px;font-size:15px;line-height:1.6;color:#374151}
  .box{background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:20px;margin:20px 0}
  .row{margin-bottom:12px}.row:last-child{margin-bottom:0}
  .label{font-weight:600;color:#4b5563;font-size:13px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
  .value{font-size:15px;color:#111827}
  .footer{background:#f9fafb;padding:24px 32px;text-align:center;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280}
</style></head><body><div class="container">
  <div class="header"><h1>${BRAND_NAME}</h1></div>
  <div class="body">${bodyContent}</div>
  <div class="footer"><p>Need help? Contact ${SUPPORT_EMAIL}</p><p style="font-size:11px;color:#9ca3af">This email was sent regarding your ${BRAND_NAME} booking.</p></div>
</div></body></html>`;
}

// ─── Content builder ────────────────────────────────────────────────────
function buildEmailContent(type: EmailType, data: BookingEmailData): { subject: string; html: string; text: string } {
  const fare = typeof data.estimatedFare === "number" ? data.estimatedFare.toFixed(2) : String(data.estimatedFare ?? "");

  switch (type) {
    case "booking_confirmation": {
      const subject = `Booking Confirmation - ${BRAND_NAME} (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour booking (${data.bookingReference}) is confirmed.\nPickup: ${data.pickupDate} ${data.pickupTime} at ${data.pickupAddress}\nDestination: ${data.dropoffAddress}\nVehicle: ${data.vehicleType}\nFare: £${fare}\n\nThank you for choosing ${BRAND_NAME}.`;
      const html = `
        <p>Hi ${data.passengerName},</p><p>Your booking has been <strong>confirmed</strong>.</p>
        <div class="box">
          <div class="row"><div class="label">Booking Reference</div><div class="value" style="font-weight:700;color:#2563eb">${data.bookingReference}</div></div>
          <div class="row"><div class="label">Pickup Date & Time</div><div class="value">${data.pickupDate} ${data.pickupTime}</div></div>
          <div class="row"><div class="label">Pickup Address</div><div class="value">${data.pickupAddress}</div></div>
          <div class="row"><div class="label">Destination</div><div class="value">${data.dropoffAddress}</div></div>
          <div class="row"><div class="label">Vehicle</div><div class="value">${data.vehicleType}</div></div>
          <div class="row"><div class="label">Fare</div><div class="value" style="font-weight:700">£${fare}</div></div>
        </div>`;
      return { subject, html: wrapHtmlEmail("Booking Confirmation", html), text };
    }

    case "booking_cancelled": {
      const reason = data.cancellationReason || "Customer request";
      const subject = `Booking Cancelled - ${BRAND_NAME} (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nYour booking (${data.bookingReference}) has been cancelled.\nReason: ${reason}\n\nIf you have questions, contact ${SUPPORT_EMAIL}.`;
      const html = `
        <p>Hi ${data.passengerName},</p><p>Your booking has been <strong>cancelled</strong>.</p>
        <div class="box" style="border-left:4px solid #ef4444">
          <div class="row"><div class="label">Booking Reference</div><div class="value">${data.bookingReference}</div></div>
          <div class="row"><div class="label">Reason</div><div class="value">${reason}</div></div>
        </div>`;
      return { subject, html: wrapHtmlEmail("Booking Cancelled", html), text };
    }

    case "refund_requested": {
      const subject = `Refund Request Received - ${BRAND_NAME} (${data.bookingReference})`;
      const refdRef = data.refundReference || data.bookingReference;
      const text = `Hi ${data.passengerName},\n\nWe received your refund request for booking ${data.bookingReference}.\nRefund reference: ${refdRef}\nAmount: £${data.refundAmount ?? fare}\nReason: ${data.refundReason || "Not specified"}\n\nOur team will review and respond shortly.`;
      const html = `
        <p>Hi ${data.passengerName},</p><p>We've received your <strong>refund request</strong> and our team is reviewing it.</p>
        <div class="box" style="border-left:4px solid #3b82f6">
          <div class="row"><div class="label">Booking Reference</div><div class="value">${data.bookingReference}</div></div>
          <div class="row"><div class="label">Refund Reference</div><div class="value" style="font-weight:700;color:#2563eb">${refdRef}</div></div>
          <div class="row"><div class="label">Refund Amount</div><div class="value" style="font-weight:700">£${data.refundAmount ?? fare}</div></div>
          <div class="row"><div class="label">Reason</div><div class="value">${data.refundReason || "Not specified"}</div></div>
        </div>
        <p>You'll receive another email once a decision is made.</p>`;
      return { subject, html: wrapHtmlEmail("Refund Request Received", html), text };
    }

    case "refund_approved": {
      const subject = `Refund Approved - ${BRAND_NAME} (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nGood news — your refund for booking ${data.bookingReference} has been approved.\nAmount: £${data.refundAmount ?? fare}\nMethod: ${data.refundMethod || "Original payment method"}\n\nThe refund may take 5–10 business days to appear.`;
      const html = `
        <p>Hi ${data.passengerName},</p><p style="font-weight:600;color:#16a34a">Good news — your refund has been approved.</p>
        <div class="box" style="border-left:4px solid #16a34a">
          <div class="row"><div class="label">Booking Reference</div><div class="value">${data.bookingReference}</div></div>
          <div class="row"><div class="label">Refund Amount</div><div class="value" style="font-weight:700;color:#16a34a">£${data.refundAmount ?? fare}</div></div>
          <div class="row"><div class="label">Refund Method</div><div class="value">${data.refundMethod || "Original payment method"}</div></div>
          ${data.refundDecisionReason ? `<div class="row"><div class="label">Note</div><div class="value">${data.refundDecisionReason}</div></div>` : ""}
        </div>
        <p>Please allow 5–10 business days for the refund to appear.</p>`;
      return { subject, html: wrapHtmlEmail("Refund Approved", html), text };
    }

    case "refund_rejected": {
      const subject = `Refund Request Update - ${BRAND_NAME} (${data.bookingReference})`;
      const text = `Hi ${data.passengerName},\n\nWe've reviewed your refund request for booking ${data.bookingReference}. Unfortunately we're unable to approve it.\nReason: ${data.refundDecisionReason || "Does not meet refund policy"}\n\nIf you disagree, reply to this email.`;
      const html = `
        <p>Hi ${data.passengerName},</p><p>We've reviewed your refund request and unfortunately we're <strong>unable to approve it</strong>.</p>
        <div class="box" style="border-left:4px solid #ef4444">
          <div class="row"><div class="label">Booking Reference</div><div class="value">${data.bookingReference}</div></div>
          <div class="row"><div class="label">Reason</div><div class="value">${data.refundDecisionReason || "Does not meet refund policy"}</div></div>
        </div>
        <p>If you believe this is an error, reply to this email or contact ${SUPPORT_EMAIL}.</p>`;
      return { subject, html: wrapHtmlEmail("Refund Request Update", html), text };
    }
  }
}

// ─── Send ────────────────────────────────────────────────────────────────
/**
 * Send an automated email. Tries port 587 (STARTTLS) first, then 465 (SSL).
 * IMPORTANT: Gmail SMTP requires an App Password (2FA must be on).
 * Generate one at https://myaccount.google.com/apppasswords
 */
export async function sendBookingEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const config = getSmtpConfig();
  const targetEmail = options.to?.trim() || options.data?.passengerEmail?.trim();
  if (!targetEmail) {
    return { success: false, error: "Recipient email is missing." };
  }
  const { subject, html, text } = buildEmailContent(options.type, options.data);
  console.log(`[Email] Sending "${options.type}" to ${targetEmail}`);

  const portsToTry = config.port === 587 ? [587, 465] : [config.port, 587, 465];
  const mailOptions: nodemailer.SendMailOptions = {
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to: targetEmail,
    replyTo: config.replyTo,
    subject,
    text,
    html,
  };

  let lastError: Error & { code?: string } | null = null;
  for (const tryPort of portsToTry) {
    try {
      cachedTransporter = null; cachedResolvedIp = null;
      const transporter = await getEmailTransporter(true, tryPort);
      const info = await transporter.sendMail(mailOptions);
      console.log(`[Email] Sent via ${tryPort}. ID: ${info.messageId}`);
      return { success: true, messageId: info.messageId, details: { provider: "smtp", port: tryPort, response: info.response } };
    } catch (error) {
      cachedTransporter = null; cachedResolvedIp = null;
      const err = error as Error & { code?: string };
      console.warn(`[Email] Port ${tryPort} failed: ${err.message} (${err.code})`);
      lastError = err;
    }
  }

  let hint = "";
  const code = lastError?.code;
  if (code === "EAUTH") hint = " Gmail auth failed — verify the App Password and that 2FA is enabled.";
  else if (code === "ECONNRESET" || code === "ETIMEDOUT") hint = " SMTP ports blocked/timed out — use a host that allows outbound 587/465 (Railway/Vercel block these).";
  return { success: false, error: `Failed to send via SMTP (${portsToTry.join(",")}): ${lastError?.message}${hint}`, details: { code } };
}

import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";
import { randomInt } from "node:crypto";

/**
 * Booking-confirmation email notifier.
 *
 * The web booking form sends the confirmation email immediately inside
 * POST /api/bookings. But the mobile app creates bookings by writing directly
 * to `later_bookings` (no email). This notifier scans recently-created
 * bookings that haven't been confirmed and sends the booking_confirmation
 * email — so app-created bookings get the same confirmation as web bookings.
 *
 * Idempotent: each sent booking is recorded with the `booking_confirmation`
 * marker in its `reminder_emails_sent` jsonb. The web booking route writes
 * the same marker after its immediate send, so app + web never double-send.
 *
 * Rides on the reminders cron (5-minute schedule).
 */

/** Only confirm bookings created within this window (avoids emailing ancient rows). */
const CONFIRM_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const CONFIRM_MARKER = "booking_confirmation";

/** Statuses that should not receive a confirmation email. */
const SKIP_STATUSES = new Set(["cancelled", "canceled", "completed", "no_show"]);

interface BookingRow {
  id: string;
  status: string | null;
  pickup_at: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  vehicle_type: string | null;
  passengers: number | null;
  estimated_fare: number | string | null;
  payment_method: string | null;
  payment_status: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  customer_email: string | null;
  customer_name: string | null;
  flight_number: string | null;
  otp: string | null;
  reminder_emails_sent: string[] | null;
}

export interface ConfirmationOutcome {
  sent: { bookingReference: string; email: string }[];
  failed: { bookingReference: string; error: string }[];
  skipped: number;
  scanned: number;
}

function bookingReferenceFromId(id: string): string {
  return `UTO-${String(id).slice(0, 8).toUpperCase()}`;
}

function resolvePassengerName(row: BookingRow): string {
  const first = row.first_name?.trim();
  const last = row.last_name?.trim();
  if (first || last) return `${first ?? ""} ${last ?? ""}`.trim();
  if (row.name?.trim()) return row.name.trim();
  if (row.customer_name?.trim()) return row.customer_name.trim();
  return "Valued Customer";
}

function resolvePaymentMethod(row: BookingRow): string {
  if (row.payment_method?.trim()) {
    return row.payment_method.trim().toLowerCase() === "stripe"
      ? "Credit Card (Stripe)"
      : row.payment_method.trim();
  }
  if (row.payment_status?.trim()?.toLowerCase() === "coupon") return "Coupon Discount";
  return "Pay in Vehicle";
}

function resolveFare(row: BookingRow): string {
  const fare = row.estimated_fare;
  if (fare === null || fare === undefined || fare === "") return "0.00";
  const num = typeof fare === "number" ? fare : Number(fare);
  if (!Number.isFinite(num)) return String(fare);
  return num.toFixed(2);
}

/**
 * Scans recently-created bookings and sends the confirmation email to any that
 * haven't already received it.
 */
export async function processUnconfirmedBookings(now: Date = new Date()): Promise<ConfirmationOutcome> {
  const supabase = getSupabaseAdmin();
  const outcome: ConfirmationOutcome = { sent: [], failed: [], skipped: 0, scanned: 0 };

  const sinceIso = new Date(now.getTime() - CONFIRM_LOOKBACK_MS).toISOString();

  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(
      "id, status, pickup_at, pickup_address, dropoff_address, vehicle_type, passengers, estimated_fare, payment_method, payment_status, name, first_name, last_name, email, customer_email, customer_name, flight_number, otp, reminder_emails_sent"
    )
    .not("email", "is", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false, nullsFirst: false })
    .limit(250);

  if (error) {
    throw new Error(`Failed to query unconfirmed bookings: ${error.message}`);
  }

  const bookings = (data ?? []) as BookingRow[];
  outcome.scanned = bookings.length;

  for (const row of bookings) {
    if (row.status && SKIP_STATUSES.has(row.status.toLowerCase())) {
      outcome.skipped++;
      continue;
    }

    const recipient = row.email?.trim() || row.customer_email?.trim();
    if (!recipient) {
      outcome.skipped++;
      continue;
    }

    const sentKeys = Array.isArray(row.reminder_emails_sent)
      ? (row.reminder_emails_sent as string[])
      : [];
    if (sentKeys.includes(CONFIRM_MARKER)) {
      outcome.skipped++;
      continue;
    }

    const bookingReference = bookingReferenceFromId(row.id);

    // Ensure the booking has a ride-start PIN. App-created bookings may not
    // set otp; generate + persist one so the rider gets it in this email and
    // the driver can verify ride start against later_bookings.otp.
    let ridePin = row.otp?.trim() || "";
    if (!ridePin) {
      ridePin = String(randomInt(0, 10000)).padStart(4, "0");
      const { error: otpErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ otp: ridePin })
        .eq("id", row.id);
      if (otpErr) {
        console.warn(`[Confirmations] Failed to persist otp for ${bookingReference}: ${otpErr.message}`);
      }
    }

    const emailData: BookingEmailData = {
      bookingReference,
      passengerName: resolvePassengerName(row),
      passengerEmail: recipient,
      pickupDate: row.pickup_at ? row.pickup_at.split("T")[0] : "N/A",
      pickupTime: row.pickup_at ? row.pickup_at.split("T")[1]?.slice(0, 5) ?? "N/A" : "N/A",
      pickupAddress: row.pickup_address?.trim() || "N/A",
      dropoffAddress: row.dropoff_address?.trim() || "N/A",
      vehicleType: row.vehicle_type?.trim() || "Standard Vehicle",
      passengers: row.passengers ?? 1,
      estimatedFare: resolveFare(row),
      paymentMethod: resolvePaymentMethod(row),
      notes: row.flight_number?.trim() ? `Flight: ${row.flight_number.trim()}` : undefined,
      ridePin,
    };

    const sendResult = await sendBookingEmail({
      to: recipient,
      type: "booking_confirmation",
      data: emailData,
    });

    if (sendResult.success) {
      const updated = Array.from(new Set([...sentKeys, CONFIRM_MARKER]));
      const { error: updErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ reminder_emails_sent: updated })
        .eq("id", row.id);
      if (updErr) {
        console.warn(
          `[Confirmations] Email sent for ${bookingReference} but failed to record marker: ${updErr.message}`
        );
      }
      outcome.sent.push({ bookingReference, email: recipient });
      console.log(`[Confirmations] Sent booking confirmation to ${recipient} for ${bookingReference}`);
    } else {
      outcome.failed.push({ bookingReference, error: sendResult.error || "Unknown SMTP error" });
      console.error(`[Confirmations] Failed for ${recipient} (${bookingReference}): ${sendResult.error}`);
    }
  }

  return outcome;
}

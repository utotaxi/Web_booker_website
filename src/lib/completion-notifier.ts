import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";

/**
 * Trip-completion email notifier.
 *
 * The driver app may finish a trip by writing `status = 'completed'` directly
 * to `later_bookings` (bypassing /api/bookings/complete), which sends no email.
 * This notifier scans recently-completed bookings and sends the
 * "trip_completed" email (which now includes the receipt + Google review
 * request) to any that haven't already received it.
 *
 * Idempotent: each sent booking is recorded with the `trip_completed` marker
 * in its `reminder_emails_sent` jsonb, so it's never sent twice. The
 * /api/bookings/complete route writes the same marker, so the two paths never
 * double-send.
 *
 * Rides on the reminders cron (5-minute schedule).
 */

/** Only email trips completed within this window so ancient trips are skipped. */
const COMPLETION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COMPLETION_MARKER = "trip_completed";

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
  rider_email: string | null;
  rider_name: string | null;
  reminder_emails_sent: string[] | null;
}

export interface CompletionOutcome {
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
  if (row.rider_name?.trim()) return row.rider_name.trim();
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

function resolvePickupDate(row: BookingRow): string {
  if (row.pickup_at) return row.pickup_at.split("T")[0];
  return "N/A";
}

function resolvePickupTime(row: BookingRow): string {
  if (row.pickup_at) return row.pickup_at.split("T")[1]?.slice(0, 5) ?? "N/A";
  return "N/A";
}

/**
 * Scans recently-completed bookings and sends the trip-completed email to any
 * that haven't already received it.
 */
export async function processCompletedTrips(now: Date = new Date()): Promise<CompletionOutcome> {
  const supabase = getSupabaseAdmin();
  const outcome: CompletionOutcome = { sent: [], failed: [], skipped: 0, scanned: 0 };

  const sinceIso = new Date(now.getTime() - COMPLETION_LOOKBACK_MS).toISOString();

  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(
      "id, status, pickup_at, pickup_address, dropoff_address, vehicle_type, passengers, estimated_fare, payment_method, payment_status, name, first_name, last_name, email, reminder_emails_sent"
    )
    .eq("status", "completed")
    .not("email", "is", null)
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(250);

  if (error) {
    throw new Error(`Failed to query completed bookings: ${error.message}`);
  }

  const bookings = (data ?? []) as BookingRow[];
  outcome.scanned = bookings.length;

  for (const row of bookings) {
    const recipient = row.email?.trim() || row.customer_email?.trim() || row.rider_email?.trim();
    if (!recipient) {
      outcome.skipped++;
      continue;
    }

    const sentKeys = Array.isArray(row.reminder_emails_sent)
      ? (row.reminder_emails_sent as string[])
      : [];
    if (sentKeys.includes(COMPLETION_MARKER)) {
      outcome.skipped++;
      continue;
    }

    const bookingReference = bookingReferenceFromId(row.id);
    const emailData: BookingEmailData = {
      bookingReference,
      passengerName: resolvePassengerName(row),
      passengerEmail: recipient,
      pickupDate: resolvePickupDate(row),
      pickupTime: resolvePickupTime(row),
      pickupAddress: row.pickup_address?.trim() || "N/A",
      dropoffAddress: row.dropoff_address?.trim() || "N/A",
      vehicleType: row.vehicle_type?.trim() || "Standard Vehicle",
      passengers: row.passengers ?? 1,
      estimatedFare: resolveFare(row),
      paymentMethod: resolvePaymentMethod(row),
    };

    const sendResult = await sendBookingEmail({
      to: recipient,
      type: "trip_completed",
      data: emailData,
    });

    if (sendResult.success) {
      const updated = Array.from(new Set([...sentKeys, COMPLETION_MARKER]));
      const { error: updErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ reminder_emails_sent: updated })
        .eq("id", row.id);
      if (updErr) {
        console.warn(
          `[Completions] Email sent for ${bookingReference} but failed to record marker: ${updErr.message}`
        );
      }
      outcome.sent.push({ bookingReference, email: recipient });
      console.log(`[Completions] Sent trip-completed email to ${recipient} for ${bookingReference}`);
    } else {
      outcome.failed.push({ bookingReference, error: sendResult.error || "Unknown SMTP error" });
      console.error(`[Completions] Failed for ${recipient} (${bookingReference}): ${sendResult.error}`);
    }
  }

  return outcome;
}

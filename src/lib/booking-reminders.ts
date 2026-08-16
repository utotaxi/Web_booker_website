import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
  getSupabaseTableColumns,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";
import { randomInt } from "node:crypto";

/**
 * Reminder windows sent before a booking's scheduled pickup time.
 * Long-lead windows (180d/60d/30d) only fire when the booking was made far
 * enough in advance that the window is still meaningful (see processDueReminders).
 *
 * `key`  — stored in `reminder_emails_sent` jsonb to dedupe.
 * `ms`   — offset before pickup, in milliseconds.
 * `label`— human-readable phrasing used in the email subject / body.
 */
export interface ReminderWindow {
  key: string;
  ms: number;
  label: string;
}

export const REMINDER_WINDOWS: ReminderWindow[] = [
  { key: "180d", ms: 180 * 24 * 60 * 60 * 1000, label: "in 180 days" },
  { key: "60d", ms: 60 * 24 * 60 * 60 * 1000, label: "in 60 days" },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000, label: "in 30 days" },
  { key: "48h", ms: 48 * 60 * 60 * 1000, label: "in 48 hours" },
  { key: "24h", ms: 24 * 60 * 60 * 1000, label: "in 24 hours" },
  { key: "12h", ms: 12 * 60 * 60 * 1000, label: "in 12 hours" },
  { key: "6h", ms: 6 * 60 * 60 * 1000, label: "in 6 hours" },
  { key: "4h", ms: 4 * 60 * 60 * 1000, label: "in 4 hours" },
];

// Pickups more than this far in the future are not worth scanning — the largest
// reminder window is 180 days, so anything beyond that (plus a buffer) is the
// only thing we'd ever act on. Kept generous to be safe.
const LOOKAHEAD_MS = 181 * 24 * 60 * 60 * 1000;

/** Statuses that should no longer receive reminder emails. */
const INACTIVE_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "canceled",
]);

interface BookingRow {
  id: string;
  status: string | null;
  pickup_at: string | null;
  pickup_date: string | null;
  pickup_time: string | null;
  pickup_address: string | null;
  pickup: string | null;
  dropoff_address: string | null;
  dropoff: string | null;
  vehicle_type: string | null;
  vehicle: string | null;
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
  created_at: string | null;
  otp: string | null;
  reminder_emails_sent: string[] | null;
}

export interface ReminderOutcome {
  sent: { bookingReference: string; window: string }[];
  failed: { bookingReference: string; window: string; error: string }[];
  skipped: number;
  scanned: number;
}

/**
 * Derives the booking reference the same way the booking route does:
 * `UTO-` + first 8 chars of the row id, uppercased.
 */
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

function resolveVehicleType(row: BookingRow): string {
  return row.vehicle_type?.trim() || row.vehicle?.trim() || "Standard Vehicle";
}

function resolvePickupDate(row: BookingRow): string {
  if (row.pickup_date?.trim()) return row.pickup_date.trim();
  if (row.pickup_at) return row.pickup_at.split("T")[0];
  return "N/A";
}

function resolvePickupTime(row: BookingRow): string {
  if (row.pickup_time?.trim()) return row.pickup_time.trim();
  if (row.pickup_at) return row.pickup_at.split("T")[1]?.slice(0, 5) ?? "N/A";
  return "N/A";
}

function resolveFare(row: BookingRow): string {
  const fare = row.estimated_fare;
  if (fare === null || fare === undefined || fare === "") return "0.00";
  const num = typeof fare === "number" ? fare : Number(fare);
  if (!Number.isFinite(num)) return String(fare);
  return num.toFixed(2);
}

function alreadySent(sent: string[] | null, key: string): boolean {
  return Array.isArray(sent) && sent.includes(key);
}

/**
 * Scans upcoming bookings and sends any reminder emails that are due.
 * Safe to call repeatedly — each window key is recorded in
 * `reminder_emails_sent` so it is only ever sent once per booking.
 *
 * A reminder window only fires if the booking existed (was created) before
 * that window's trigger time. This prevents sending "180 days before" emails
 * for a booking made two days ago.
 */
export async function processDueReminders(now: Date = new Date()): Promise<ReminderOutcome> {
  const supabase = getSupabaseAdmin();
  const outcome: ReminderOutcome = { sent: [], failed: [], skipped: 0, scanned: 0 };

  const fromIso = now.toISOString();
  const toIso = new Date(now.getTime() + LOOKAHEAD_MS).toISOString();

  // Pull every pickup between now and the lookahead horizon. We filter the
  // active-window logic in code because reminder timing is relative to both
  // pickup_at and created_at, which is awkward to express purely in SQL.
  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(
      "id, status, pickup_at, pickup_address, dropoff_address, vehicle_type, passengers, estimated_fare, payment_method, payment_status, name, first_name, last_name, email, created_at, otp, reminder_emails_sent"
    )
    .gte("pickup_at", fromIso)
    .lte("pickup_at", toIso)
    .order("pickup_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to query upcoming bookings: ${error.message}`);
  }

  const bookings = (data ?? []) as BookingRow[];
  outcome.scanned = bookings.length;

  // The reminder_emails_sent column may not exist yet on tables where the
  // migration hasn't run. Detect once so we can degrade gracefully.
  let hasReminderColumn = true;
  try {
    const columns = await getSupabaseTableColumns(BOOKINGS_TABLE);
    hasReminderColumn = columns.has("reminder_emails_sent");
  } catch {
    // Introspection failed — assume the column exists; writes will surface the real error.
  }

  for (const row of bookings) {
    if (row.status && INACTIVE_STATUSES.has(row.status.toLowerCase())) {
      outcome.skipped++;
      continue;
    }

    if (!row.pickup_at) {
      outcome.skipped++;
      continue;
    }

    const pickupMs = Date.parse(row.pickup_at);
    if (!Number.isFinite(pickupMs)) {
      outcome.skipped++;
      continue;
    }

    const recipient = row.email?.trim() || row.customer_email?.trim() || row.rider_email?.trim();
    if (!recipient) {
      outcome.skipped++;
      continue;
    }

    const createdMs = row.created_at ? Date.parse(row.created_at) : pickupMs;
    const createdOk = Number.isFinite(createdMs) ? createdMs : pickupMs;

    const sentKeys = Array.isArray(row.reminder_emails_sent)
      ? row.reminder_emails_sent
      : [];

    const bookingReference = bookingReferenceFromId(row.id);

    let ridePin = row.otp?.trim() || "";
    if (!ridePin) {
      ridePin = String(randomInt(0, 10000)).padStart(4, "0");
      const { error: otpErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ otp: ridePin })
        .eq("id", row.id);
      if (otpErr) {
        console.warn(`[Booking Reminders] Failed to persist otp for ${bookingReference}: ${otpErr.message}`);
      }
    }

    for (const window of REMINDER_WINDOWS) {
      if (alreadySent(sentKeys as string[], window.key)) continue;

      const triggerMs = pickupMs - window.ms; // when this reminder becomes due

      // Not due yet.
      if (now.getTime() < triggerMs) continue;

      // The booking wasn't created far enough in advance for this window to be
      // meaningful — skip it (e.g. don't send "180 days before" for a booking
      // made a week ago). Allow a small tolerance so windows fire reliably.
      const TOLERANCE_MS = 5 * 60 * 1000;
      if (createdOk > triggerMs + TOLERANCE_MS) continue;

      const emailData: BookingEmailData = {
        bookingReference,
        passengerName: resolvePassengerName(row),
        passengerEmail: recipient,
        pickupDate: resolvePickupDate(row),
        pickupTime: resolvePickupTime(row),
        pickupAddress: row.pickup_address?.trim() || row.pickup?.trim() || "N/A",
        dropoffAddress: row.dropoff_address?.trim() || row.dropoff?.trim() || "N/A",
        vehicleType: resolveVehicleType(row),
        passengers: row.passengers ?? 1,
        estimatedFare: resolveFare(row),
        paymentMethod: resolvePaymentMethod(row),
        reminderWindow: window.label,
        ridePin,
      };

      const sendResult = await sendBookingEmail({
        to: recipient,
        type: "booking_reminder",
        data: emailData,
      });

      if (sendResult.success) {
        // Record this window so it's never resent.
        const updatedKeys = Array.from(new Set([...(sentKeys as string[]), window.key]));
        if (hasReminderColumn) {
          const { error: updateError } = await supabase
            .from(BOOKINGS_TABLE)
            .update({ reminder_emails_sent: updatedKeys })
            .eq("id", row.id);
          if (updateError) {
            console.warn(
              `[Reminders] Email sent for ${bookingReference} (${window.key}) but failed to record dedupe state: ${updateError.message}`
            );
          }
        }
        outcome.sent.push({ bookingReference, window: window.key });
        console.log(
          `[Reminders] Sent "${window.key}" reminder to ${recipient} for ${bookingReference}`
        );
      } else {
        outcome.failed.push({
          bookingReference,
          window: window.key,
          error: sendResult.error || "Unknown SMTP error",
        });
        console.error(
          `[Reminders] Failed to send "${window.key}" reminder to ${recipient} for ${bookingReference}: ${sendResult.error}`
        );
      }
    }
  }

  return outcome;
}

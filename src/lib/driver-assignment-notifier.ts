import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData } from "@/lib/email-service";
import { randomInt } from "node:crypto";

/**
 * Driver-assignment email notifier.
 *
 * The driver / dispatch app assigns a driver by writing directly to
 * `later_bookings` (setting `assignment_status = 'accepted'` + `driver_id`).
 * That path sends no email — so this notifier scans for newly-accepted
 * bookings and dispatches the "driver_assigned" email with the driver's
 * vehicle details and phone number.
 *
 * Vehicle details live on the `drivers` table (keyed by `drivers.id` =
 * `later_bookings.driver_id`); the driver's name and phone live on `users`
 * (keyed by `users.id` = `drivers.user_id`).
 *
 * Dedupe: we store `driver_assigned:<driver_id>` in the booking's
 * `reminder_emails_sent` jsonb column. If the same driver is re-confirmed we
 * do not re-send; if a *different* driver is later assigned to the same
 * booking the marker differs and a fresh email is sent.
 *
 * Trigger via the cron route `/api/cron/driver-assignments` every few minutes.
 */

/** Statuses that should no longer receive a driver-assigned email. */
const INACTIVE_STATUSES = new Set([
  "cancelled",
  "canceled",
  "completed",
  "no_show",
]);

interface BookingRow {
  id: string;
  status: string | null;
  assignment_status: string | null;
  driver_id: string | null;
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
  otp: string | null;
  reminder_emails_sent: string[] | null;
}

interface DriverRow {
  id: string;
  user_id: string | null;
  vehicle_make: string | null;
  vehicle_model: string | null;
  vehicle_color: string | null;
  license_plate: string | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
  phone: string | null;
}

export interface AssignmentOutcome {
  sent: { bookingReference: string; driver: string }[];
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

function driverMarker(driverId: string): string {
  return `driver_assigned:${driverId}`;
}

/**
 * Scans accepted bookings and sends the driver-assigned email to any that
 * haven't already been notified for their current driver.
 */
export async function processAcceptedDriverAssignments(): Promise<AssignmentOutcome> {
  const supabase = getSupabaseAdmin();
  const outcome: AssignmentOutcome = { sent: [], failed: [], skipped: 0, scanned: 0 };

  // The driver app signals "driver accepted" by setting status='driver_accepted'
  // (assignment_status is a legacy column used on older cancelled trips).
  // Only bookings with a passenger email are candidates. The per-driver marker
  // check in code makes re-runs safe, so we don't need a tight time window.
  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(
      "id, status, assignment_status, driver_id, pickup_at, pickup_address, dropoff_address, vehicle_type, passengers, estimated_fare, payment_method, payment_status, name, first_name, last_name, email, otp, reminder_emails_sent"
    )
    .eq("status", "driver_accepted")
    .not("email", "is", null)
    .order("pickup_at", { ascending: false, nullsFirst: false })
    .limit(250);

  if (error) {
    throw new Error(`Failed to query accepted bookings: ${error.message}`);
  }

  const bookings = (data ?? []) as BookingRow[];
  outcome.scanned = bookings.length;

  // Skip bookings that are inactive (cancelled/completed) or missing a driver.
  const eligible = bookings.filter((row) => {
    if (row.status && INACTIVE_STATUSES.has(row.status.toLowerCase())) {
      outcome.skipped++;
      return false;
    }
    if (!row.driver_id?.trim()) {
      outcome.skipped++;
      return false;
    }
    return true;
  });

  // Batch-resolve vehicle details for every distinct driver_id.
  const driverIds = Array.from(
    new Set(eligible.map((r) => r.driver_id!.trim()).filter(Boolean))
  );
  const driverMap = new Map<string, DriverRow>();
  const userMap = new Map<string, UserRow>();

  if (driverIds.length > 0) {
    const { data: drivers, error: driversErr } = await supabase
      .from("drivers")
      .select("id, user_id, vehicle_make, vehicle_model, vehicle_color, license_plate")
      .in("id", driverIds);
    if (driversErr) {
      throw new Error(`Failed to query drivers: ${driversErr.message}`);
    }
    for (const d of (drivers ?? []) as DriverRow[]) {
      driverMap.set(d.id, d);
    }

    const userIds = Array.from(
      new Set(
        Array.from(driverMap.values())
          .map((d) => d.user_id?.trim())
          .filter(Boolean) as string[]
      )
    );
    if (userIds.length > 0) {
      const { data: users, error: usersErr } = await supabase
        .from("users")
        .select("id, full_name, phone")
        .in("id", userIds);
      if (usersErr) {
        throw new Error(`Failed to query driver users: ${usersErr.message}`);
      }
      for (const u of (users ?? []) as UserRow[]) {
        userMap.set(u.id, u);
      }
    }
  }

  for (const row of eligible) {
    const driverId = row.driver_id!.trim();
    const recipient = row.email?.trim() || row.customer_email?.trim();
    if (!recipient) {
      outcome.skipped++;
      continue;
    }

    const bookingReference = bookingReferenceFromId(row.id);
    const sentKeys = Array.isArray(row.reminder_emails_sent)
      ? (row.reminder_emails_sent as string[])
      : [];
    const marker = driverMarker(driverId);

    // Already notified for this exact driver — don't re-send.
    if (sentKeys.includes(marker)) {
      outcome.skipped++;
      continue;
    }

    const driver = driverMap.get(driverId);
    const user = driver?.user_id ? userMap.get(driver.user_id) : undefined;

    const driverName =
      user?.full_name?.trim() ||
      row.name?.trim() || // passenger name fallback only if no driver name (shouldn't happen)
      "Your assigned driver";
    const driverPhone = user?.phone?.trim() || undefined;

    let ridePin = row.otp?.trim() || "";
    if (!ridePin) {
      ridePin = String(randomInt(0, 10000)).padStart(4, "0");
      const { error: otpErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ otp: ridePin })
        .eq("id", row.id);
      if (otpErr) {
        console.warn(`[Driver Assignment Notifier] Failed to persist otp for ${bookingReference}: ${otpErr.message}`);
      }
    }

    const emailData: BookingEmailData = {
      bookingReference,
      passengerName: resolvePassengerName(row),
      passengerEmail: recipient,
      pickupDate: resolvePickupDate(row),
      pickupTime: resolvePickupTime(row),
      pickupAddress: row.pickup_address?.trim() || row.pickup?.trim() || "N/A",
      dropoffAddress: row.dropoff_address?.trim() || row.dropoff?.trim() || "N/A",
      vehicleType: row.vehicle_type?.trim() || row.vehicle?.trim() || "Standard Vehicle",
      passengers: row.passengers ?? 1,
      estimatedFare: resolveFare(row),
      paymentMethod: resolvePaymentMethod(row),
      driverName,
      driverPhone,
      vehicleMake: driver?.vehicle_make?.trim() || undefined,
      vehicleModel: driver?.vehicle_model?.trim() || undefined,
      vehicleColour: driver?.vehicle_color?.trim() || undefined,
      vehicleRegistration: driver?.license_plate?.trim() || undefined,
      // ETA is not stored on the booking; the template omits the row when absent.
      eta: undefined,
      ridePin,
    };

    const sendResult = await sendBookingEmail({
      to: recipient,
      type: "driver_assigned",
      data: emailData,
    });

    if (sendResult.success) {
      const updatedKeys = Array.from(new Set([...sentKeys, marker]));
      const { error: updateError } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ reminder_emails_sent: updatedKeys })
        .eq("id", row.id);
      if (updateError) {
        console.warn(
          `[Driver Assigned] Email sent for ${bookingReference} but failed to record dedupe state: ${updateError.message}`
        );
      }
      outcome.sent.push({ bookingReference, driver: driverName });
      console.log(
        `[Driver Assigned] Sent driver-assigned email to ${recipient} for ${bookingReference} (driver: ${driverName})`
      );
    } else {
      outcome.failed.push({
        bookingReference,
        error: sendResult.error || "Unknown SMTP error",
      });
      console.error(
        `[Driver Assigned] Failed to send to ${recipient} for ${bookingReference}: ${sendResult.error}`
      );
    }
  }

  return outcome;
}

import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
} from "@/lib/supabase-admin";
import { sendBookingEmail, type BookingEmailData, type DriverBookingItem } from "@/lib/email-service";
import { REMINDER_WINDOWS } from "@/lib/booking-reminders";

/**
 * Driver reminder email notifier.
 *
 * Mirrors the passenger reminder cadence but sends ONE email per driver
 * listing ALL of that driver's accepted upcoming bookings (status =
 * 'driver_accepted'). Triggered by the reminders cron so it rides on the
 * same 5-minute schedule (no new scheduler needed).
 *
 * Vehicle details are NOT needed here (the driver knows their own vehicle);
 * we send the passenger + pickup + fare details per booking.
 *
 * Dedupe: per (driver, window). We store `driver_reminder:<window>` on each
 * of the driver's currently-listed bookings' `reminder_emails_sent` jsonb so
 * the window doesn't re-fire from a sibling booking. A NEW booking added
 * later (un-marked for the window) correctly triggers a fresh full-list email.
 */

/** Driver reminders only use the short, operationally useful windows. */
const DRIVER_WINDOWS = REMINDER_WINDOWS.filter((w) => w.ms <= 48 * 60 * 60 * 1000);

interface BookingRow {
  id: string;
  status: string | null;
  driver_id: string | null;
  pickup_at: string | null;
  pickup_date: string | null;
  pickup_time: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  vehicle_type: string | null;
  passengers: number | null;
  estimated_fare: number | string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  flight_number: string | null;
  reminder_emails_sent: string[] | null;
}

interface DriverRow {
  id: string;
  user_id: string | null;
}

interface UserRow {
  id: string;
  full_name: string | null;
  email: string | null;
}

export interface DriverReminderOutcome {
  sent: { driver: string; email: string; window: string; bookings: number }[];
  failed: { driver: string; window: string; error: string }[];
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
  return "Passenger";
}

function resolveFare(row: BookingRow): string {
  const fare = row.estimated_fare;
  if (fare === null || fare === undefined || fare === "") return "0.00";
  const num = typeof fare === "number" ? fare : Number(fare);
  if (!Number.isFinite(num)) return String(fare);
  return num.toFixed(2);
}

/**
 * Pickup date/time resolution — MUST mirror the rider-facing notifiers.
 *
 * The rider enters pickup as local wall-clock text stored verbatim in the
 * `pickup_date` ("YYYY-MM-DD") and `pickup_time` ("HH:MM") columns. The
 * `pickup_at` timestamptz column is the UTC conversion of those and therefore
 * drifts by the local DST offset (e.g. 15:00 BST is stored as 14:00Z). Resolving
 * from `pickup_at` would show the driver a different time than the rider, so we
 * prefer the text columns and only fall back to splitting the `pickup_at` ISO
 * string (never re-formatting it through a timezone).
 */
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

function driverWindowMarker(windowKey: string): string {
  return `driver_reminder:${windowKey}`;
}

function hasMarker(sent: string[] | null, marker: string): boolean {
  return Array.isArray(sent) && sent.includes(marker);
}

/**
 * Persists queued driver-reminder markers with a fresh read-merge-write per
 * booking. Reading the current DB value (rather than a stale in-memory
 * snapshot) before merging prevents one window's write from clobbering
 * another's marker when multiple windows fire in the same run.
 */
async function flushDriverReminderMarkers(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  markersByBooking: Map<string, Set<string>>
): Promise<void> {
  for (const [bookingId, markers] of markersByBooking) {
    if (markers.size === 0) continue;
    try {
      const { data, error } = await supabase
        .from(BOOKINGS_TABLE)
        .select("id, reminder_emails_sent")
        .eq("id", bookingId)
        .maybeSingle();
      if (error) {
        console.warn(`[Driver Reminder] Failed to read markers for ${bookingId}: ${error.message}`);
        continue;
      }
      const current = Array.isArray(data?.reminder_emails_sent)
        ? (data!.reminder_emails_sent as string[])
        : [];
      const merged = Array.from(new Set([...current, ...markers]));
      const { error: updErr } = await supabase
        .from(BOOKINGS_TABLE)
        .update({ reminder_emails_sent: merged })
        .eq("id", bookingId);
      if (updErr) {
        console.warn(`[Driver Reminder] Failed to persist markers for ${bookingReferenceFromId(bookingId)}: ${updErr.message}`);
      }
    } catch (err) {
      console.warn(`[Driver Reminder] Marker flush error for ${bookingReferenceFromId(bookingId)}:`, (err as Error).message);
    }
  }
}

/**
 * Scans accepted upcoming bookings and sends each driver a reminder email
 * listing all of their accepted upcoming bookings, per reminder window.
 */
export async function processDriverReminders(now: Date = new Date()): Promise<DriverReminderOutcome> {
  const supabase = getSupabaseAdmin();
  const outcome: DriverReminderOutcome = { sent: [], failed: [], skipped: 0, scanned: 0 };

  const nowMs = now.getTime();
  // The email lists ALL of the driver's accepted upcoming bookings, so we
  // query a generous 365-day horizon (not just the largest trigger window).
  // Trigger detection (within-window) is applied in code below.
  const horizonIso = new Date(nowMs + 365 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(BOOKINGS_TABLE)
    .select(
      "id, status, driver_id, pickup_at, pickup_date, pickup_time, pickup_address, dropoff_address, vehicle_type, passengers, estimated_fare, first_name, last_name, name, flight_number, reminder_emails_sent"
    )
    .eq("status", "driver_accepted")
    .gt("pickup_at", now.toISOString())
    .lte("pickup_at", horizonIso)
    .order("pickup_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to query driver-accepted upcoming bookings: ${error.message}`);
  }

  const bookings = (data ?? []) as BookingRow[];
  outcome.scanned = bookings.length;

  // Only bookings with a driver can trigger a driver reminder.
  const withDriver = bookings.filter((b) => {
    if (!b.driver_id?.trim()) {
      outcome.skipped++;
      return false;
    }
    return true;
  });

  // Batch-resolve drivers + their users (email/name).
  const driverIds = Array.from(new Set(withDriver.map((b) => b.driver_id!.trim())));
  const driverMap = new Map<string, DriverRow>();
  const userMap = new Map<string, UserRow>();

  if (driverIds.length > 0) {
    const { data: drivers, error: dErr } = await supabase
      .from("drivers")
      .select("id, user_id")
      .in("id", driverIds);
    if (dErr) throw new Error(`Failed to query drivers: ${dErr.message}`);
    for (const d of (drivers ?? []) as DriverRow[]) driverMap.set(d.id, d);

    const userIds = Array.from(
      new Set(
        Array.from(driverMap.values())
          .map((d) => d.user_id?.trim())
          .filter(Boolean) as string[]
      )
    );
    if (userIds.length > 0) {
      const { data: users, error: uErr } = await supabase
        .from("users")
        .select("id, full_name, email")
        .in("id", userIds);
      if (uErr) throw new Error(`Failed to query driver users: ${uErr.message}`);
      for (const u of (users ?? []) as UserRow[]) userMap.set(u.id, u);
    }
  }

  // Group all upcoming accepted bookings by driver (for the email LIST).
  const byDriver = new Map<string, BookingRow[]>();
  for (const b of withDriver) {
    const arr = byDriver.get(b.driver_id!.trim()) ?? [];
    arr.push(b);
    byDriver.set(b.driver_id!.trim(), arr);
  }

  // Markers to persist, accumulated across all windows/drivers in this run.
  // Flushed once at the end with a fresh read-merge-write per booking so that
  // multiple windows (48h + 24h) firing in the same run don't clobber each
  // other's markers via a stale in-memory snapshot.
  const markersByBooking = new Map<string, Set<string>>();

  for (const window of DRIVER_WINDOWS) {
    const marker = driverWindowMarker(window.key);

    // Trigger bookings for this window: pickup within the window and not yet
    // driver-notified for it.
    const triggers = withDriver.filter((b) => {
      const pickupMs = Date.parse(b.pickup_at ?? "");
      if (!Number.isFinite(pickupMs)) return false;
      if (pickupMs > nowMs + window.ms) return false; // not due yet
      return !hasMarker(b.reminder_emails_sent, marker);
    });

    // Group triggers by driver so each driver gets at most one email per window.
    const triggersByDriver = new Map<string, BookingRow[]>();
    for (const t of triggers) {
      const arr = triggersByDriver.get(t.driver_id!.trim()) ?? [];
      arr.push(t);
      triggersByDriver.set(t.driver_id!.trim(), arr);
    }

    for (const [driverId, triggerList] of triggersByDriver) {
      const driver = driverMap.get(driverId);
      const user = driver?.user_id ? userMap.get(driver.user_id) : undefined;
      const driverName = user?.full_name?.trim() || "Driver";
      const driverEmail = user?.email?.trim();

      if (!driverEmail) {
        outcome.skipped++;
        continue;
      }

      // The email lists ALL of this driver's upcoming accepted bookings.
      const driverBookings = byDriver.get(driverId) ?? triggerList;
      const items: DriverBookingItem[] = driverBookings.map((b) => ({
        bookingReference: bookingReferenceFromId(b.id),
        passengerName: resolvePassengerName(b),
        pickupDate: resolvePickupDate(b),
        pickupTime: resolvePickupTime(b),
        pickupAddress: b.pickup_address?.trim() || "N/A",
        dropoffAddress: b.dropoff_address?.trim() || "N/A",
        vehicleType: b.vehicle_type?.trim() || "Standard Vehicle",
        estimatedFare: resolveFare(b),
        notes: b.flight_number?.trim() ? `Flight: ${b.flight_number.trim()}` : "None",
      }));

      const emailData: BookingEmailData = {
        bookingReference: items[0]?.bookingReference ?? "UTO",
        passengerName: driverName,
        passengerEmail: driverEmail,
        pickupDate: items[0]?.pickupDate ?? "N/A",
        pickupTime: items[0]?.pickupTime ?? "N/A",
        pickupAddress: items[0]?.pickupAddress ?? "N/A",
        dropoffAddress: items[0]?.dropoffAddress ?? "N/A",
        vehicleType: items[0]?.vehicleType ?? "Standard Vehicle",
        passengers: items[0] ? 1 : 1,
        estimatedFare: items[0]?.estimatedFare ?? "0.00",
        paymentMethod: "N/A",
        driverName,
        reminderWindow: window.label,
        driverUpcomingBookings: items,
      };

      const sendResult = await sendBookingEmail({
        to: driverEmail,
        type: "driver_reminder",
        data: emailData,
      });

      if (sendResult.success) {
        // Queue the marker for every listed booking; we persist once at the end
        // with a fresh read-merge-write (clobber-proof across windows/runs).
        for (const b of driverBookings) {
          if (!markersByBooking.has(b.id)) markersByBooking.set(b.id, new Set());
          markersByBooking.get(b.id)!.add(marker);
          // Keep in-memory state consistent so later windows in this run see it.
          if (!Array.isArray(b.reminder_emails_sent)) b.reminder_emails_sent = [];
          if (!(b.reminder_emails_sent as string[]).includes(marker)) {
            (b.reminder_emails_sent as string[]).push(marker);
          }
        }
        outcome.sent.push({ driver: driverName, email: driverEmail, window: window.key, bookings: items.length });
        console.log(
          `[Driver Reminder] Sent ${window.key} reminder to ${driverEmail} (${driverName}) — ${items.length} booking(s)`
        );
      } else {
        outcome.failed.push({ driver: driverName, window: window.key, error: sendResult.error || "Unknown SMTP error" });
        console.error(
          `[Driver Reminder] Failed for ${driverEmail} (${driverName}) ${window.key}: ${sendResult.error}`
        );
      }
    }
  }

  // Flush all queued markers with a fresh read-merge-write so we never
  // overwrite a marker that another window/run just recorded.
  await flushDriverReminderMarkers(supabase, markersByBooking);

  return outcome;
}

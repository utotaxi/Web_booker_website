import { NextRequest, NextResponse } from "next/server";
import { processDueReminders } from "@/lib/booking-reminders";
import { processDriverReminders } from "@/lib/driver-reminder-notifier";
import { processCompletedTrips } from "@/lib/completion-notifier";
import { processUnconfirmedBookings } from "@/lib/confirmation-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron endpoint that sends due booking-reminder emails.
 *
 * Schedule an external job (cron-job.org / GitHub Actions / Fly cron) to hit:
 *   GET/POST https://<your-domain>/api/cron/reminders
 * every 5 minutes with header `x-cron-secret: <CRON_SECRET>`.
 *
 * Two jobs run per call:
 *   1. Passenger reminders — per booking, windows 180d/60d/30d/48h/24h/12h/6h/4h.
 *   2. Driver reminders — one email per driver listing ALL their accepted
 *      upcoming bookings, windows 48h/24h/12h/6h/4h.
 *   3. Trip completions — sends the trip-completed/review email to riders
 *      whose booking was just marked completed.
 *   4. Booking confirmations — sends the confirmation email to recently
 *      created bookings that haven't got one (e.g. app-created bookings).
 *
 * All are idempotent — sent windows are recorded in each booking's
 * `reminder_emails_sent` jsonb column (`<window>` for passengers,
 * `driver_reminder:<window>` for the driver, `trip_completed` for
 * completions, `booking_confirmation` for confirmations) so nothing is ever
 * sent twice.
 */
async function runReminders() {
  const startedAt = new Date().toISOString();
  try {
    const [passengers, drivers, completions, confirmations] = await Promise.all([
      processDueReminders(),
      processDriverReminders(),
      processCompletedTrips(),
      processUnconfirmedBookings(),
    ]);
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      passengers: {
        scanned: passengers.scanned,
        skipped: passengers.skipped,
        sentCount: passengers.sent.length,
        failedCount: passengers.failed.length,
        sent: passengers.sent,
        failed: passengers.failed,
      },
      drivers: {
        scanned: drivers.scanned,
        skipped: drivers.skipped,
        sentCount: drivers.sent.length,
        failedCount: drivers.failed.length,
        sent: drivers.sent,
        failed: drivers.failed,
      },
      completions: {
        scanned: completions.scanned,
        skipped: completions.skipped,
        sentCount: completions.sent.length,
        failedCount: completions.failed.length,
        sent: completions.sent,
        failed: completions.failed,
      },
      confirmations: {
        scanned: confirmations.scanned,
        skipped: confirmations.skipped,
        sentCount: confirmations.sent.length,
        failedCount: confirmations.failed.length,
        sent: confirmations.sent,
        failed: confirmations.failed,
      },
    };
  } catch (err) {
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      error: (err as Error).message,
    };
  }
}

function isAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // If no secret is configured, allow the call (e.g. during local dev) but log
  // a warning. In production always set CRON_SECRET.
  if (!secret) {
    console.warn(
      "[Cron Reminders] CRON_SECRET is not set — endpoint is unauthenticated. Set CRON_SECRET in production."
    );
    return true;
  }
  const provided =
    req.headers.get("x-cron-secret") ||
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    req.nextUrl.searchParams.get("secret");
  return provided === secret;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runReminders();
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runReminders();
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}

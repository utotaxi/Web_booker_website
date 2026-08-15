import { NextRequest, NextResponse } from "next/server";
import { processAcceptedDriverAssignments } from "@/lib/driver-assignment-notifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron endpoint that sends the "driver_assigned" email to passengers whose
 * booking was just accepted by a driver.
 *
 * Schedule an external job (cron-job.org / GitHub Actions / Fly cron) to hit:
 *   GET/POST https://<your-domain>/api/cron/driver-assignments
 * every 5 minutes (no more) with header `x-cron-secret: <CRON_SECRET>`, so the
 * rider receives the driver-assigned email within 5 minutes of a driver being
 * assigned or accepting the ride.
 *
 * The job is idempotent — each (booking, driver) pair is recorded in the
 * booking's `reminder_emails_sent` jsonb column as `driver_assigned:<driver_id>`
 * so it is never sent twice. If a different driver is later assigned to the
 * same booking, a fresh email is sent.
 */
async function runNotifier() {
  const startedAt = new Date().toISOString();
  try {
    const outcome = await processAcceptedDriverAssignments();
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      scanned: outcome.scanned,
      skipped: outcome.skipped,
      sentCount: outcome.sent.length,
      failedCount: outcome.failed.length,
      sent: outcome.sent,
      failed: outcome.failed,
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
      "[Cron Driver Assignments] CRON_SECRET is not set — endpoint is unauthenticated. Set CRON_SECRET in production."
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
  const result = await runNotifier();
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runNotifier();
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}

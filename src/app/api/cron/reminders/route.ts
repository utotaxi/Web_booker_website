import { NextRequest, NextResponse } from "next/server";
import { processDueReminders } from "@/lib/booking-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cron endpoint that sends due booking-reminder emails.
 *
 * Schedule an external job (cron-job.org / GitHub Actions / Fly cron) to hit:
 *   GET/POST https://<your-domain>/api/cron/reminders
 * every 15-30 minutes with header `x-cron-secret: <CRON_SECRET>`.
 *
 * Reminder windows (before pickup):
 *   180 days, 60 days, 30 days, 48 hours, 24 hours, 12 hours, 6 hours, 4 hours.
 *
 * The job is idempotent — each window is recorded in the booking's
 * `reminder_emails_sent` jsonb column so it is never sent twice.
 */
async function runReminders() {
  const startedAt = new Date().toISOString();
  try {
    const outcome = await processDueReminders();
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

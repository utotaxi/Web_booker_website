# Deployment Guide — Fly.io (SMTP-friendly host)

This app sends booking emails via **Nodemailer SMTP** (Gmail App Password).
Railway blocks outbound SMTP ports 587/465, so production email fails there
(`ETIMEDOUT` on `CONN`). Fly.io allows outbound SMTP, so SMTP-only works here.

---

## 1. Prerequisites

- Fly CLI installed & authenticated:
  ```sh
  curl -L https://fly.io/install.sh | sh
  flyctl auth login
  ```
- Your `.env.local` values handy (SMTP_PASS = Gmail App Password, etc.).

## 2. Create the Fly app

```sh
flyctl launch --no-deploy --dockerfile Dockerfile
```
- App name must be globally unique. Update `app = "..."` in `fly.toml` to match.
- Choose **London (lhr)** or your nearest region. Set `primary_region` to match.
- Do **not** create a Postgres/SQLite — Supabase is your DB, hosted externally.

## 3. Fill in build args (public, client-facing values)

Edit `fly.toml` → `[build.args]` and replace the four placeholders with the
**same values as your `.env.local`** for the `NEXT_PUBLIC_*` keys. These are
inlined into the client bundle at build time, so they cannot be runtime secrets.

```toml
[build.args]
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY = "your-google-maps-key"
  NEXT_PUBLIC_SUPABASE_URL = "https://<id>.supabase.co"
  NEXT_PUBLIC_SUPABASE_ANON_KEY = "your-anon-key"
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_live_..."
```

## 4. Set runtime secrets (server-only, never baked into client)

Set these with the Fly CLI. **Use NO trailing newlines** (Railway had a stray
newline on `SMTP_HOST` that broke host matching — copy values cleanly).

```sh
flyctl secrets set \
  GOOGLE_PLACES_API_KEY="..." \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  STRIPE_SECRET_KEY="..." \
  SMTP_HOST="smtp.gmail.com" \
  SMTP_PORT="587" \
  SMTP_SECURE="false" \
  SMTP_USER="bookings@utotransfer.co.uk" \
  SMTP_PASS="your-gmail-app-password" \
  SMTP_FROM_EMAIL="bookings@utotransfer.co.uk" \
  SMTP_FROM_NAME="UTO Transfer" \
  SMTP_REPLY_TO="bookings@utotransfer.co.uk" \
  WEB_BOOKER_RIDER_ID="optional-rider-uuid" \
  CRON_SECRET="pick-a-long-random-string"
```

> The `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` /
> `GMAIL_USER_EMAIL` vars from your old `.env.local` are **no longer used**
> (Gmail API/OAuth2 path was removed) — do not set them.
>
> `CRON_SECRET` protects the `/api/cron/reminders` endpoint (see §9). Omit it
> only for local dev.

## 5. Deploy

```sh
flyctl deploy
```
First deploy builds the image, provisions a machine, and starts it.

## 6. Verify email in production

```sh
# SMTP connection check (should now return success: true)
curl https://<your-app>.fly.dev/api/email/test

# Send a real booking confirmation to a real external address
curl -X POST https://<your-app>.fly.dev/api/email/send \
  -H "Content-Type: application/json" \
  -d '{"type":"booking_confirmation","to":"<your-email>","data":{...}}'
```

You should get `250 2.0.0 OK ... gsmtp` and the email should land in the inbox
(check spam the first time). If still `ETIMEDOUT`, your region/network may need
outbound SMTP — contact Fly support or try another region.

## 7. Point your domain (optional)

```sh
flyctl certs create booker.utotransfer.co.uk
```
Then add the CNAME Fly gives you in your DNS provider. Set
`SMTP_REPLY_TO` / `SMTP_FROM_EMAIL` accordingly (already bookings@utotransfer.co.uk).

## 8. Deliverability (recommended)

Since you send from `bookings@utotransfer.co.uk` via Google Workspace SMTP,
make sure `utotransfer.co.uk` DNS has Google's sending SPF:
```
utotransfer.co.uk.  TXT  "v=spf1 include:_spf.google.com ~all"
```
DKIM for Google Workspace is configured in the Google Admin console →
Apps → Google Workspace → Gmail → Authenticate email. This keeps booking
confirmations out of recipients' spam folders.

---

## 9. Booking reminder emails (automated)

The app sends reminder emails automatically before each pickup at these windows:

- **180 days, 60 days, 30 days** before pickup (long-lead reminders — only fire
  when a booking was made that far in advance).
- **48 hours, 24 hours, 12 hours, 6 hours, 4 hours** before pickup.

The reminder copy matches the agreed template (booking details, free-cancellation
up to 3 hours before, journey-change policy, and the UTO Customer Support sign-off
with 📞 07596266901 and 🌐 www.utotransfer.co.uk).

### 9.1 One-time DB migration

Run `supabase_add_reminders.sql` in the Supabase SQL Editor:

- https://supabase.com/dashboard/project/tadqvfnqykmjdxzpoczp/sql/new

This adds the `reminder_emails_sent jsonb` column used to dedupe so a reminder
is never sent twice for the same booking.

### 9.2 How it works

`src/lib/booking-reminders.ts` (`processDueReminders`) scans upcoming bookings,
finds windows whose trigger time (`pickup_at − offset`) has passed and that
weren't already sent, and dispatches a `booking_reminder` email via the same
SMTP transport as confirmations. Each fired window is recorded in
`reminder_emails_sent`, so the job is idempotent and safe to run repeatedly.

It is exposed at `GET/POST /api/cron/reminders`, protected by the `CRON_SECRET`
header (`x-cron-secret`), so it can be called by an external scheduler.

### 9.3 Schedule it (Fly auto-stops machines, so use an external cron)

Fly's `auto_stop_machines = 'stop'` means an in-process `setInterval` timer
would die when the machine spins down. Use an external cron that pings the
endpoint every **15–30 minutes**:

**Option A — cron-job.org (free, no infra):**
- URL: `https://<your-app>.fly.dev/api/cron/reminders`
- Method: `GET`
- Headers: `x-cron-secret: <CRON_SECRET>`
- Schedule: every 15 minutes (`*/15 * * * *`)

**Option B — GitHub Actions** (`.github/workflows/reminders.yml`):
```yaml
name: UTO reminder emails
on:
  schedule:
    - cron: "*/15 * * * *"
jobs:
  fire:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X GET \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}" \
            "https://${{ secrets.APP_DOMAIN }}/api/cron/reminders"
```

**Option C — Fly Machine cron** (if you prefer to keep it on Fly):
```sh
flyctl machines run --command "curl -fsS -X GET -H 'x-cron-secret: <CRON_SECRET>' http://localhost:3000/api/cron/reminders" --schedule "*/15 * * * *"
```

### 9.4 Test it

```sh
# Local dev (CRON_SECRET unset = allowed with a warning)
curl http://localhost:3000/api/cron/reminders

# Production (with secret)
curl -H "x-cron-secret: $CRON_SECRET" https://<your-app>.fly.dev/api/cron/reminders
```

Response includes `scanned`, `skipped`, `sent`, and `failed` arrays so you can
see exactly which bookings got which window. You can also send a one-off test
reminder via the existing test endpoint:
```sh
curl -X POST https://<your-app>.fly.dev/api/email/test \
  -H "Content-Type: application/json" \
  -d '{"type":"booking_reminder","to":"<your-email>"}'
```

### 9.5 Driver-assigned email to the rider (automated, ≤5 min)

When a driver is **assigned** (`status='assigned'` + `driver_id`) or **accepts**
(`status='driver_accepted'`) a ride — via the driver/dispatch app writing
directly to `later_bookings` — the rider must receive the `driver_assigned`
email within 5 minutes. The dispatch integration route `POST /api/bookings/assign`
sends the email synchronously (immediate); the direct-write path relies on this
cron notifier (`src/lib/driver-assignment-notifier.ts`) which is idempotent —
each `(booking, driver_id)` pair is recorded in `reminder_emails_sent` as
`driver_assigned:<driver_id>` so it is never sent twice, and a re-assignment to
a different driver correctly sends a fresh email.

It is exposed at `GET/POST /api/cron/driver-assignments`, protected by the same
`CRON_SECRET` header. **Schedule it every 5 minutes** (no less frequently, so
the 5-minute SLA holds):

**Option A — cron-job.org (free, no infra):**
- URL: `https://<your-app>.fly.dev/api/cron/driver-assignments`
- Method: `GET`
- Headers: `x-cron-secret: <CRON_SECRET>`
- Schedule: every 5 minutes (`*/5 * * * *`)

**Option B — GitHub Actions** (`.github/workflows/driver-assignments.yml`):
```yaml
name: UTO driver-assignment emails
on:
  schedule:
    - cron: "*/5 * * * *"
jobs:
  fire:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X GET \
          -H "x-cron-secret: ${{ secrets.CRON_SECRET }}" \
          "https://${{ secrets.APP_DOMAIN }}/api/cron/driver-assignments"
```

> Pickup time in these emails is read from the `pickup_date`/`pickup_time`
> columns (the local wall-clock the rider entered), so the schedule shown to
> the rider, the driver, and in reminders is always identical.

### 9.6 Trip-completed receipt (triggered on completion)

When a trip finishes, your driver / dispatch system should call:

```sh
curl -X POST https://<your-app>.fly.dev/api/bookings/complete \
  -H "Content-Type: application/json" \
  -H "x-cron-secret: $CRON_SECRET" \
  -d '{"id":"<supabase-row-id>"}'
# or by reference:  -d '{"bookingReference":"UTO-AB12CD34"}'
```

This marks the booking `status = "completed"` and sends the `trip_completed`
receipt email (with the Google review request ⭐
https://g.page/r/CXeCrCQPe8vaEBE/review). It's idempotent — calling it again on
an already-completed booking does nothing unless you pass `{"id":"...","force":true}`.

Test the template without touching a real booking:
```sh
curl -X POST https://<your-app>.fly.dev/api/email/test \
  -H "Content-Type: application/json" \
  -d '{"type":"trip_completed","to":"<your-email>"}'
```

### 9.7 Env vars summary

| Variable | Purpose |
|---|---|
| `CRON_SECRET` | Protects `/api/cron/reminders`, `/api/cron/driver-assignments`, and `/api/bookings/complete` |
| `SMTP_*` | Same transport as confirmations |
| `SUPABASE_SERVICE_ROLE_KEY` | Reads/writes `later_bookings` for reminders |

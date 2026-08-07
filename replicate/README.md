# Email Replication Kit — Book / Cancel / Refund

Drop-in SMTP email service for an app where users **book**, **cancel**, and
**request refunds**. Built on the same verified setup as the UTO Web Booker.

## What's in here

| File | What it is |
|---|---|
| `email-service.ts` | The core sender. Framework-agnostic Node/TS module (Nodemailer SMTP). Drop into `src/lib/`. |
| `api/email/test/route.ts` | Test endpoint: `GET` verifies SMTP, `POST` sends a real test email. |
| `api/book/route.ts` | Example **booking** flow → sends `booking_confirmation`. |
| `api/cancel/route.ts` | Example **cancel** flow → sends `booking_cancelled`. |
| `api/refund/route.ts` | User **requests refund** → sends `refund_requested`. |
| `api/refund/process/route.ts` | Admin **approves/rejects** refund → sends `refund_approved` / `refund_rejected`. |
| `.env.example` | Env var sheet. |

## Email types

- `booking_confirmation` — sent when a booking is created.
- `booking_cancelled` — sent when a booking is cancelled (with reason).
- `refund_requested` — sent to the user when they request a refund.
- `refund_approved` — sent when an admin approves the refund (amount + method).
- `refund_rejected` — sent when an admin rejects the refund (with reason).

## Step-by-step replication

### 1. Install dependency

```sh
npm install nodemailer
npm install -D @types/nodemailer
```

### 2. Copy the files

- `email-service.ts` → `src/lib/email-service.ts`
- `api/**` → `src/app/api/**` (keep the folder structure: Next.js App Router maps folders to routes).

### 3. Set environment variables

Copy `.env.example` to `.env.local` (dev) and fill values. At minimum:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=bookings@yourdomain.com
SMTP_PASS=<gmail app password>
SMTP_FROM_EMAIL=bookings@yourdomain.com
SMTP_FROM_NAME=Your Brand
SMTP_REPLY_TO=bookings@yourdomain.com
BRAND_NAME=Your Brand
BRAND_SUPPORT_EMAIL=support@yourdomain.com
```

Generate the App Password at https://myaccount.google.com/apppasswords
(2FA must be enabled on the Google account).

### 4. (Re)brand the templates

`BRAND_NAME` and `BRAND_SUPPORT_EMAIL` are env-driven (defaults are UTO).
Edit the `wrapHtmlEmail()` and `buildEmailContent()` in `email-service.ts`
if you need different layout/colors/copy.

### 5. Wire into your real flows

The route files have clearly marked `// persist the booking in your DB`
placeholders. Replace those with your Supabase/Prisma/SQL calls. The email
send block above each return statement is the part you keep.

Key pattern (already in the route examples): **await the email send inside
try/catch so a failed email doesn't fail the booking/refund** — the customer
should still see success, and you log/email-alert the SMTP failure separately.

### 6. Test locally

```sh
npm run dev
# Verify SMTP:
curl http://localhost:3000/api/email/test
# Send a real test email:
curl -X POST http://localhost:3000/api/email/test \
  -H "Content-Type: application/json" \
  -d '{"to":"your-email@gmail.com"}'
```

Expect `success: true` and a `250 2.0.0 OK ... gsmtp` response. Check your
inbox (and spam the first time).

### 7. Deploy to an SMTP-friendly host

Outbound ports 587/465 MUST be open. Good hosts: **Fly.io**, a VPS
(Hetzner/DigitalOcean), Render (paid), Cloud Run. Bad hosts (block SMTP):
Railway, Vercel, Netlify.

For Fly.io, a complete Dockerfile + `fly.toml` + deploy guide already exists
in the parent repo (see `../Dockerfile`, `../fly.toml`, `../DEPLOYMENT.md`).
The only host requirement is the open SMTP port.

### 8. Deliverability (recommended)

Since you send from `bookings@yourdomain.com` via Google Workspace SMTP, make
sure your domain's DNS has Google's sending SPF, and DKIM is enabled in the
Google Admin console:

```
yourdomain.com.  TXT  "v=spf1 include:_spf.google.com ~all"
```

This keeps confirmations/refunds out of recipients' spam.

## Adapting to a non-Next.js stack

`email-service.ts` is framework-agnostic — it's just a Node module. Only the
route files are Next.js-specific. In Express, for example:

```ts
import { sendBookingEmail } from "./lib/email-service";
router.post("/book", async (req, res) => {
  // ... persist
  await sendBookingEmail({ to: req.body.email, type: "booking_confirmation", data: {...} });
  res.status(201).json({ ok: true });
});
```

## Notes & gotchas

- **Self-send suppression:** Gmail often won't show an email in the inbox
  if `from` and `to` are the same address (bookings@ → bookings@). Test by
  sending to a *different* external address.
- **Trailing newline in env vars:** Some host UIs add a stray `\n` to the
  `SMTP_HOST` value. That breaks host matching. Set it cleanly.
- **Port fallback:** The sender tries 587 (STARTTLS) then 465 (SSL). If your
  host only allows 465, set `SMTP_PORT=465`.
- **Refund + actual money movement:** `/api/refund/process` approves the
  *email* side. When `decision === 'approved'`, call your payment provider's
  refund API (e.g. Stripe `refunds.create`) *before* sending the email, so
  the customer is only told a refund succeeded once the money is actually moving.

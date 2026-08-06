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
  WEB_BOOKER_RIDER_ID="optional-rider-uuid"
```

> The `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` /
> `GMAIL_USER_EMAIL` vars from your old `.env.local` are **no longer used**
> (Gmail API/OAuth2 path was removed) — do not set them.

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

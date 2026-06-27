import Stripe from "stripe";

let cachedClient: Stripe | null = null;

export function getStripeSecretKey(): string | null {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  return key ? key : null;
}

export function isStripeConfigured(): boolean {
  return Boolean(getStripeSecretKey());
}

/**
 * Returns a memoised server-side Stripe client. Throws when the secret key is
 * missing so callers can surface a clear configuration error.
 */
export function getStripe(): Stripe {
  const key = getStripeSecretKey();
  if (!key) {
    throw new Error(
      "Stripe is not configured. Set STRIPE_SECRET_KEY in the environment."
    );
  }
  if (!cachedClient) {
    cachedClient = new Stripe(key);
  }
  return cachedClient;
}

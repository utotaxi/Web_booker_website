"use client";

import { useState } from "react";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from "@stripe/react-stripe-js";

const publishableKey =
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY?.trim() ?? "";

let stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise() {
  if (!publishableKey) return null;
  if (!stripePromise) {
    stripePromise = loadStripe(publishableKey);
  }
  return stripePromise;
}

interface StripePaymentFormProps {
  clientSecret: string;
  amountLabel: string;
  onPaid: () => void | Promise<void>;
  onBack: () => void;
  processing: boolean;
}

function PaymentFields({
  amountLabel,
  onPaid,
  onBack,
  processing,
}: Omit<StripePaymentFormProps, "clientSecret">) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  const busy = paying || processing;

  const handlePay = async () => {
    if (!stripe || !elements) return;
    setError(null);
    setPaying(true);

    const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: "if_required",
      confirmParams: {
        return_url: window.location.href,
      },
    });

    if (confirmError) {
      setError(confirmError.message ?? "Payment could not be completed.");
      setPaying(false);
      return;
    }

    if (paymentIntent && paymentIntent.status === "succeeded") {
      await onPaid();
      setPaying(false);
      return;
    }

    setError("Payment was not completed. Please try again.");
    setPaying(false);
  };

  return (
    <div className="space-y-5">
      <PaymentElement />

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="rounded-md border border-gray-300 bg-white px-6 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handlePay}
          disabled={!stripe || !elements || busy}
          className="rounded-md bg-navy px-6 py-2.5 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-navy-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? "Processing…" : `Pay ${amountLabel} & Confirm`}
        </button>
      </div>
    </div>
  );
}

export default function StripePaymentForm({
  clientSecret,
  amountLabel,
  onPaid,
  onBack,
  processing,
}: StripePaymentFormProps) {
  const promise = getStripePromise();

  if (!promise) {
    return (
      <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Payment is not configured. Please set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
      </div>
    );
  }

  return (
    <Elements
      stripe={promise}
      options={{
        clientSecret,
        appearance: { theme: "stripe", variables: { colorPrimary: "#0a1f44" } },
      }}
    >
      <PaymentFields
        amountLabel={amountLabel}
        onPaid={onPaid}
        onBack={onBack}
        processing={processing}
      />
    </Elements>
  );
}

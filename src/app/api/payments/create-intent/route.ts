import { NextRequest, NextResponse } from "next/server";
import { calculateBookingQuote } from "@/lib/booking-quote";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getStripe, isStripeConfigured } from "@/lib/stripe";
import {
  resolveVehicleSelection,
  VEHICLE_BOOKING_LIMITS,
} from "@/lib/vehicle-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PASSENGERS = VEHICLE_BOOKING_LIMITS.minibus.maxPassengers;
const MAX_LUGGAGE = VEHICLE_BOOKING_LIMITS.minibus.maxLuggage;

interface IntentPayload {
  pickup?: string;
  dropoff?: string;
  stops?: string[];
  vehicle?: string;
  passengers?: number;
  luggage?: number;
  return_journey?: boolean;
  return_pickup?: string;
  return_dropoff?: string;
  return_stops?: string[];
  return_passengers?: number;
  return_luggage?: number;
  email?: string;
  first_name?: string;
  last_name?: string;
}

function normalizePassengers(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(MAX_PASSENGERS, Math.round(parsed)));
}

function normalizeLuggage(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(MAX_LUGGAGE, Math.round(parsed)));
}

export async function POST(req: NextRequest) {
  // If Stripe is not configured, signal the client to skip payment so local
  // development (without keys) still works end to end.
  if (!isStripeConfigured()) {
    return NextResponse.json({ configured: false });
  }

  let payload: IntentPayload;
  try {
    payload = (await req.json()) as IntentPayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!payload.pickup?.trim() || !payload.dropoff?.trim()) {
    return NextResponse.json(
      { error: "Pickup and dropoff are required to take payment." },
      { status: 400 }
    );
  }

  const normalizedPassengers = normalizePassengers(payload.passengers);
  const normalizedLuggage = normalizeLuggage(payload.luggage);
  const isRoundTrip = payload.return_journey ?? false;
  const returnPassengers = isRoundTrip
    ? normalizePassengers(payload.return_passengers ?? payload.passengers)
    : normalizedPassengers;
  const returnLuggage = isRoundTrip
    ? normalizeLuggage(payload.return_luggage ?? payload.luggage)
    : normalizedLuggage;

  const resolvedVehicle = resolveVehicleSelection(
    payload.vehicle,
    Math.max(normalizedPassengers, returnPassengers),
    Math.max(normalizedLuggage, returnLuggage)
  );

  try {
    const supabase = getSupabaseAdmin();
    const quote = await calculateBookingQuote(
      {
        pickup: payload.pickup.trim(),
        dropoff: payload.dropoff.trim(),
        stops: payload.stops ?? [],
        vehicle: resolvedVehicle.displayName,
        passengers: normalizedPassengers,
        luggage: normalizedLuggage,
        return_journey: isRoundTrip,
        return_pickup: payload.return_pickup,
        return_dropoff: payload.return_dropoff,
        return_stops: payload.return_stops ?? [],
      },
      supabase
    );

    // Stripe charges in the smallest currency unit (pence for GBP).
    const amountInPence = Math.round(quote.estimated_fare * 100);
    if (!Number.isFinite(amountInPence) || amountInPence < 30) {
      return NextResponse.json(
        { error: "Calculated fare is too low to charge. Please review the trip." },
        { status: 400 }
      );
    }

    const stripe = getStripe();
    const customerName = `${payload.first_name ?? ""} ${payload.last_name ?? ""}`.trim();
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInPence,
      currency: "gbp",
      automatic_payment_methods: { enabled: true },
      description: `Ride: ${payload.pickup.trim()} -> ${payload.dropoff.trim()}`,
      receipt_email: payload.email?.trim() || undefined,
      metadata: {
        pickup: payload.pickup.trim().slice(0, 480),
        dropoff: payload.dropoff.trim().slice(0, 480),
        vehicle: resolvedVehicle.displayName,
        round_trip: String(isRoundTrip),
        fare_gbp: quote.estimated_fare.toFixed(2),
        customer_name: customerName.slice(0, 480),
      },
    });

    return NextResponse.json({
      configured: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount: amountInPence,
      currency: "gbp",
      fare: quote.estimated_fare,
    });
  } catch (error) {
    const message = (error as Error).message || "Failed to start payment.";
    return NextResponse.json(
      {
        error:
          message.toLowerCase() === "fetch failed"
            ? "Could not start payment right now. Please check the addresses and try again."
            : message,
      },
      { status: 500 }
    );
  }
}

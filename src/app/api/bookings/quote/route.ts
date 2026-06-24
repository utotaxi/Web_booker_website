import { NextRequest, NextResponse } from "next/server";
import { calculateBookingQuote } from "@/lib/booking-quote";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import {
  resolveVehicleSelection,
  VEHICLE_BOOKING_LIMITS,
} from "@/lib/vehicle-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_PASSENGERS = VEHICLE_BOOKING_LIMITS.minibus.maxPassengers;
const MAX_LUGGAGE = VEHICLE_BOOKING_LIMITS.minibus.maxLuggage;

interface QuotePayload {
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
  let payload: QuotePayload;
  try {
    payload = (await req.json()) as QuotePayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!payload.pickup?.trim() || !payload.dropoff?.trim()) {
    return NextResponse.json(
      { error: "Pickup and dropoff are required to calculate fare." },
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

  // One vehicle serves the whole trip, so it must fit the busiest leg.
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

    return NextResponse.json({ quote });
  } catch (error) {
    const message = (error as Error).message || "Failed to calculate quote.";
    return NextResponse.json(
      {
        error:
          message.toLowerCase() === "fetch failed"
            ? "Could not calculate fare right now. Please check the selected addresses and try again."
            : message,
      },
      { status: 500 }
    );
  }
}

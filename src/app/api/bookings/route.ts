import { NextRequest, NextResponse } from "next/server";
import { calculateBookingQuote } from "@/lib/booking-quote";
import {
  BOOKINGS_TABLE,
  getSupabaseAdmin,
  getSupabaseTableColumns,
} from "@/lib/supabase-admin";
import {
  resolveVehicleSelection,
  VEHICLE_BOOKING_LIMITS,
} from "@/lib/vehicle-compatibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_PASSENGERS = VEHICLE_BOOKING_LIMITS.minibus.maxPassengers;
const MAX_LUGGAGE = VEHICLE_BOOKING_LIMITS.minibus.maxLuggage;

interface BookingPayload {
  rider_id?: string;
  pickup?: string;
  dropoff?: string;
  stops?: string[];
  pickup_date?: string;
  pickup_time?: string;
  pickup_datetime?: string;
  vehicle?: string;
  passengers?: number;
  luggage?: number;
  return_journey?: boolean;
  return_pickup?: string;
  return_dropoff?: string;
  return_stops?: string[];
  return_passengers?: number;
  return_luggage?: number;
  return_date?: string;
  return_time?: string;
  return_datetime?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone_number?: string;
  booking_for_someone_else?: boolean;
  flight_info?: string;
  arrival_from?: string;
  additional_note?: string;
}

function pickColumns(
  source: Record<string, unknown>,
  allowedColumns: Set<string>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([column, value]) => allowedColumns.has(column) && value !== undefined
    )
  );
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

async function resolveRiderId(
  payloadRiderId: string | undefined,
  supabase: ReturnType<typeof getSupabaseAdmin>
): Promise<string> {
  if (payloadRiderId?.trim()) return payloadRiderId.trim();
  if (process.env.WEB_BOOKER_RIDER_ID?.trim()) {
    return process.env.WEB_BOOKER_RIDER_ID.trim();
  }

  const { data, error } = await supabase
    .from("users")
    .select("id")
    .eq("role", "rider")
    .eq("is_deleted", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data?.id) {
    throw new Error(
      "No rider account available for web bookings. Set WEB_BOOKER_RIDER_ID in .env.local or create at least one rider in users."
    );
  }

  return String(data.id);
}

export async function POST(req: NextRequest) {
  let payload: BookingPayload;
  try {
    payload = (await req.json()) as BookingPayload;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!payload.pickup?.trim() || !payload.dropoff?.trim()) {
    return NextResponse.json(
      { error: "Pickup and dropoff are required." },
      { status: 400 }
    );
  }

  const pickupDateTimeIso =
    payload.pickup_datetime && !Number.isNaN(Date.parse(payload.pickup_datetime))
      ? new Date(payload.pickup_datetime).toISOString()
      : payload.pickup_date &&
          payload.pickup_time &&
          !Number.isNaN(Date.parse(`${payload.pickup_date}T${payload.pickup_time}:00`))
        ? new Date(`${payload.pickup_date}T${payload.pickup_time}:00`).toISOString()
        : null;

  if (!pickupDateTimeIso) {
    return NextResponse.json(
      { error: "Pickup date and time are required." },
      { status: 400 }
    );
  }

  const normalizedPassengers = normalizePassengers(payload.passengers);
  const normalizedLuggage = normalizeLuggage(payload.luggage);

  const isRoundTrip = Boolean(payload.return_journey);
  const returnPickupAddress = payload.return_pickup?.trim() || payload.dropoff.trim();
  const returnDropoffAddress =
    payload.return_dropoff?.trim() || payload.pickup.trim();
  const returnStops = (payload.return_stops ?? [])
    .map((stop) => stop?.trim())
    .filter((stop): stop is string => Boolean(stop));

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

  const returnAtIso =
    isRoundTrip && payload.return_datetime &&
    !Number.isNaN(Date.parse(payload.return_datetime))
      ? new Date(payload.return_datetime).toISOString()
      : isRoundTrip &&
          payload.return_date &&
          payload.return_time &&
          !Number.isNaN(
            Date.parse(`${payload.return_date}T${payload.return_time}:00`)
          )
        ? new Date(`${payload.return_date}T${payload.return_time}:00`).toISOString()
        : null;

  const record = {
    pickup_address: payload.pickup.trim(),
    pickup: payload.pickup.trim(),
    dropoff_address: payload.dropoff.trim(),
    dropoff: payload.dropoff.trim(),
    pickup_date: payload.pickup_date ?? null,
    pickup_time: payload.pickup_time ?? null,
    pickup_datetime: pickupDateTimeIso,
    pickup_at: pickupDateTimeIso,
    vehicle_type: resolvedVehicle.backendType,
    vehicle: resolvedVehicle.displayName,
    passengers: normalizedPassengers,
    luggage: normalizedLuggage,
    is_round_trip: isRoundTrip,
    return_journey: isRoundTrip,
    booking_type: "standard",
    status: "scheduled",
  };

  try {
    const supabase = getSupabaseAdmin();
    const riderId = await resolveRiderId(payload.rider_id, supabase);
    const quote = await calculateBookingQuote(
      {
        pickup: payload.pickup.trim(),
        dropoff: payload.dropoff.trim(),
        stops: payload.stops ?? [],
        vehicle: resolvedVehicle.displayName,
        passengers: normalizedPassengers,
        luggage: normalizedLuggage,
        return_journey: isRoundTrip,
        return_pickup: returnPickupAddress,
        return_dropoff: returnDropoffAddress,
        return_stops: returnStops,
      },
      supabase
    );

    const travelMinutes = Math.max(
      1,
      quote.duration_minutes * (payload.return_journey ? 2 : 1)
    );
    const dropoffByIso = pickupDateTimeIso
      ? new Date(
          new Date(pickupDateTimeIso).getTime() + travelMinutes * 60 * 1000
        ).toISOString()
      : null;

    const candidateInsert = {
      ...record,
      rider_id: riderId,
      dropoff_by: dropoffByIso,
      stops: quote.stops,
      stops_text: quote.stops.length ? quote.stops.join(" -> ") : null,
      stops_count: quote.stops.length,
      outbound_distance_miles: quote.outbound.distance_miles,
      outbound_duration_minutes: quote.outbound.duration_minutes,
      outbound_fare: quote.outbound.fare,
      return_pickup_address: isRoundTrip ? returnPickupAddress : null,
      return_dropoff_address: isRoundTrip ? returnDropoffAddress : null,
      return_stops: isRoundTrip ? (quote.return_leg?.stops ?? returnStops) : [],
      return_stops_text:
        isRoundTrip && (quote.return_leg?.stops ?? returnStops).length
          ? (quote.return_leg?.stops ?? returnStops).join(" -> ")
          : null,
      return_stops_count: isRoundTrip
        ? (quote.return_leg?.stops ?? returnStops).length
        : 0,
      return_passengers: isRoundTrip ? returnPassengers : null,
      return_luggage: isRoundTrip ? returnLuggage : null,
      return_at: returnAtIso,
      return_distance_miles: quote.return_leg?.distance_miles ?? null,
      return_duration_minutes: quote.return_leg?.duration_minutes ?? null,
      return_fare: quote.return_leg?.fare ?? null,
      estimated_fare: quote.estimated_fare,
      fare: quote.estimated_fare,
      distance_miles: quote.distance_miles,
      duration_minutes: quote.duration_minutes,
      pickup_latitude: quote.pickup_latitude,
      pickup_longitude: quote.pickup_longitude,
      dropoff_latitude: quote.dropoff_latitude,
      dropoff_longitude: quote.dropoff_longitude,
      pricing_rule_id: quote.pricing_rule_id,
      pricing_rule_name: quote.pricing_rule_name,
      pricing_breakdown: quote.pricing_breakdown,
      quote_source: quote.distance_source,
      quote_currency: quote.currency,
      first_name: payload.first_name ?? null,
      last_name: payload.last_name ?? null,
      email: payload.email ?? null,
      phone_number: payload.phone_number ?? null,
      phone: payload.phone_number ?? null,
      booking_for_someone_else: payload.booking_for_someone_else ?? false,
      flight_info: payload.flight_info ?? null,
      flight_number: payload.flight_info ?? null,
      arrival_from: payload.arrival_from ?? null,
      additional_note: payload.additional_note ?? null,
      notes: payload.additional_note ?? null,
      customer_name:
        payload.first_name || payload.last_name
          ? `${payload.first_name ?? ""} ${payload.last_name ?? ""}`.trim()
          : null,
      customer_email: payload.email ?? null,
      customer_phone: payload.phone_number ?? null,
    };

    const allowedColumns = await getSupabaseTableColumns(BOOKINGS_TABLE);
    const insertRecord = pickColumns(candidateInsert, allowedColumns);

    if (
      !allowedColumns.has("pickup_address") &&
      !allowedColumns.has("pickup")
    ) {
      throw new Error(
        'later_bookings table is missing pickup columns. Expected "pickup_address" or "pickup".'
      );
    }
    if (
      !allowedColumns.has("dropoff_address") &&
      !allowedColumns.has("dropoff")
    ) {
      throw new Error(
        'later_bookings table is missing dropoff columns. Expected "dropoff_address" or "dropoff".'
      );
    }

    const { data, error } = await supabase
      .from(BOOKINGS_TABLE)
      .insert(insertRecord)
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: error.message, hint: error.hint ?? null, code: error.code ?? null },
        { status: 500 }
      );
    }

    return NextResponse.json({ booking: data, quote }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Failed to store booking." },
      { status: 500 }
    );
  }
}

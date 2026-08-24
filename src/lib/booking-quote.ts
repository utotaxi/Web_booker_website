import type { SupabaseClient } from "@supabase/supabase-js";
import {
  quoteServiceAreaLeg,
  type ServiceAreaQuote,
} from "@/lib/service-area-quote";

interface RouteCoordinates {
  lat: number;
  lng: number;
}

interface RouteMetrics {
  distanceMiles: number;
  durationMinutes: number;
  pickupCoordinates: RouteCoordinates | null;
  dropoffCoordinates: RouteCoordinates | null;
  source: "google_directions" | "haversine_estimate";
}

interface DirectionsLeg {
  distance?: { value?: number };
  duration?: { value?: number };
  start_location?: RouteCoordinates;
  end_location?: RouteCoordinates;
}

interface DirectionsResponse {
  status?: string;
  error_message?: string;
  routes?: { legs?: DirectionsLeg[] }[];
}

interface FindPlaceResponse {
  status?: string;
  candidates?: {
    geometry?: {
      location?: RouteCoordinates;
    };
  }[];
}

export interface BookingQuotePayload {
  pickup: string;
  dropoff: string;
  stops?: string[];
  vehicle: string;
  passengers?: number;
  luggage?: number;
  return_journey?: boolean;
  return_pickup?: string;
  return_dropoff?: string;
  return_stops?: string[];
}

export interface QuoteLegResult {
  pickup: string;
  dropoff: string;
  stops: string[];
  distance_miles: number;
  duration_minutes: number;
  fare: number;
  mile_rate: number;
  minute_rate: number;
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  distance_source: "google_directions" | "haversine_estimate";
}

export interface BookingQuoteResult {
  estimated_fare: number;
  distance_miles: number;
  duration_minutes: number;
  pricing_rule_id: string | null;
  pricing_rule_name: string | null;
  /** Billing policy: inside, inbound, outbound, or base→pickup (both outside). */
  route_mode: string | null;
  route_label: string | null;
  /** `pricing_rules` inside/inbound/outbound; `service_area_base_pricing` when both points are beyond the circle. */
  pricing_source: string | null;
  pricing_breakdown: {
    vehicle_label: string;
    start_price: number;
    min_price: number;
    outbound_distance_miles: number;
    outbound_duration_minutes: number;
    outbound_fare: number;
    return_distance_miles: number;
    return_duration_minutes: number;
    return_fare: number;
    is_round_trip: boolean;
    final_fare: number;
  };
  pickup_latitude: number | null;
  pickup_longitude: number | null;
  dropoff_latitude: number | null;
  dropoff_longitude: number | null;
  distance_source: "google_directions" | "haversine_estimate";
  currency: "GBP";
  stops: string[];
  outbound: QuoteLegResult;
  return_leg: QuoteLegResult | null;
}

const METERS_TO_MILES = 0.000621371;
const AVERAGE_SPEED_MPH_FALLBACK = 24;
const GOOGLE_FETCH_RETRIES = 2;

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

async function fetchGoogleJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= GOOGLE_FETCH_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      if (attempt === GOOGLE_FETCH_RETRIES) return null;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }

  return null;
}

async function tryGoogleDirections(
  points: string[],
  apiKey: string
): Promise<RouteMetrics | null> {
  const origin = points[0];
  const destination = points[points.length - 1];
  const middle = points.slice(1, -1);

  const params = new URLSearchParams({
    origin,
    destination,
    region: "uk",
    units: "imperial",
    key: apiKey,
  });

  if (middle.length) {
    params.set("waypoints", middle.join("|"));
  }

  const data = await fetchGoogleJson<DirectionsResponse>(
    `https://maps.googleapis.com/maps/api/directions/json?${params.toString()}`
  );

  if (!data || data.status !== "OK" || !data.routes?.length) {
    return null;
  }

  const legs = data.routes[0].legs ?? [];
  if (!legs.length) return null;

  const totalMeters = legs.reduce(
    (sum, leg) => sum + toNumber(leg.distance?.value, 0),
    0
  );
  const totalSeconds = legs.reduce(
    (sum, leg) => sum + toNumber(leg.duration?.value, 0),
    0
  );

  const firstLeg = legs[0];
  const lastLeg = legs[legs.length - 1];

  return {
    distanceMiles: totalMeters * METERS_TO_MILES,
    durationMinutes: totalSeconds / 60,
    pickupCoordinates: firstLeg.start_location ?? null,
    dropoffCoordinates: lastLeg.end_location ?? null,
    source: "google_directions",
  };
}

async function geocodeWithPlacesFind(
  address: string,
  apiKey: string
): Promise<RouteCoordinates | null> {
  const params = new URLSearchParams({
    input: address,
    inputtype: "textquery",
    fields: "geometry/location",
    key: apiKey,
  });

  const data = await fetchGoogleJson<FindPlaceResponse>(
    `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params.toString()}`
  );

  if (!data || data.status !== "OK" || !data.candidates?.length) {
    return null;
  }

  return data.candidates[0].geometry?.location ?? null;
}

function haversineMiles(a: RouteCoordinates, b: RouteCoordinates): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const angle =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusMiles * Math.atan2(Math.sqrt(angle), Math.sqrt(1 - angle));
}

async function fallbackHaversineRoute(
  points: string[],
  apiKey: string
): Promise<RouteMetrics> {
  const coordinates = await Promise.all(
    points.map((point) => geocodeWithPlacesFind(point, apiKey))
  );

  if (coordinates.some((point) => !point)) {
    throw new Error(
      "Could not map one or more addresses. Please select full addresses from suggestions."
    );
  }

  const validPoints = coordinates as RouteCoordinates[];
  let totalMiles = 0;

  for (let index = 0; index < validPoints.length - 1; index += 1) {
    totalMiles += haversineMiles(validPoints[index], validPoints[index + 1]);
  }

  const durationMinutes = totalMiles > 0
    ? (totalMiles / AVERAGE_SPEED_MPH_FALLBACK) * 60
    : 0;

  return {
    distanceMiles: totalMiles,
    durationMinutes,
    pickupCoordinates: validPoints[0] ?? null,
    dropoffCoordinates: validPoints[validPoints.length - 1] ?? null,
    source: "haversine_estimate",
  };
}

async function getRouteMetrics(points: string[], apiKey: string): Promise<RouteMetrics> {
  const fromDirections = await tryGoogleDirections(points, apiKey);
  if (fromDirections) return fromDirections;
  return fallbackHaversineRoute(points, apiKey);
}

async function computeLeg(
  pickup: string,
  dropoff: string,
  stops: string[],
  apiKey: string,
  vehicleType: string,
  supabase: SupabaseClient
): Promise<{ leg: QuoteLegResult; quote: ServiceAreaQuote }> {
  const points = [pickup, ...stops, dropoff];
  const route = await getRouteMetrics(points, apiKey);

  if (!route.pickupCoordinates || !route.dropoffCoordinates) {
    throw new Error(
      "Could not map trip coordinates. Please select full addresses from suggestions."
    );
  }

  // Fare comes from pricing_rules (inside, inbound, or outbound) or
  // service_area_base_pricing (both points beyond the circle).
  const quote = await quoteServiceAreaLeg(supabase, {
    pickup: route.pickupCoordinates,
    dropoff: route.dropoffCoordinates,
    minutes: route.durationMinutes,
    vehicleType,
  });

  const leg: QuoteLegResult = {
    pickup,
    dropoff,
    stops,
    distance_miles: round(route.distanceMiles, 2),
    duration_minutes: Math.max(1, Math.round(route.durationMinutes)),
    fare: quote.price,
    mile_rate: round(quote.breakdown.mileage / Math.max(quote.billed_miles, 0.001), 4),
    minute_rate: round(
      quote.breakdown.time / Math.max(route.durationMinutes, 0.001),
      4
    ),
    pickup_latitude: route.pickupCoordinates.lat,
    pickup_longitude: route.pickupCoordinates.lng,
    dropoff_latitude: route.dropoffCoordinates.lat,
    dropoff_longitude: route.dropoffCoordinates.lng,
    distance_source: route.source,
  };

  return { leg, quote };
}

export async function calculateBookingQuote(
  payload: BookingQuotePayload,
  supabase: SupabaseClient
): Promise<BookingQuoteResult> {
  const pickup = payload.pickup.trim();
  const dropoff = payload.dropoff.trim();
  const stops = (payload.stops ?? []).map((stop) => stop.trim()).filter(Boolean);

  if (!pickup || !dropoff) {
    throw new Error("Pickup and dropoff are required for fare calculation.");
  }

  const apiKey =
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    throw new Error("Google API key is missing on the server.");
  }

  const { leg: outbound, quote: outboundQuote } = await computeLeg(
    pickup,
    dropoff,
    stops,
    apiKey,
    payload.vehicle,
    supabase
  );

  let returnLeg: QuoteLegResult | null = null;
  let returnQuote: ServiceAreaQuote | null = null;
  if (payload.return_journey) {
    const returnPickup = (payload.return_pickup ?? dropoff).trim();
    const returnDropoff = (payload.return_dropoff ?? pickup).trim();
    const returnStops = (payload.return_stops ?? [])
      .map((stop) => stop.trim())
      .filter(Boolean);

    const computed = await computeLeg(
      returnPickup,
      returnDropoff,
      returnStops,
      apiKey,
      payload.vehicle,
      supabase
    );
    returnLeg = computed.leg;
    returnQuote = computed.quote;
  }

  const totalFare = round(outbound.fare + (returnLeg?.fare ?? 0), 2);
  const totalDistance = round(
    outbound.distance_miles + (returnLeg?.distance_miles ?? 0),
    2
  );
  const totalDuration =
    outbound.duration_minutes + (returnLeg?.duration_minutes ?? 0);

  const distanceSource: "google_directions" | "haversine_estimate" =
    outbound.distance_source === "haversine_estimate" ||
    returnLeg?.distance_source === "haversine_estimate"
      ? "haversine_estimate"
      : "google_directions";

  return {
    estimated_fare: totalFare,
    distance_miles: totalDistance,
    duration_minutes: totalDuration,
    pricing_rule_id: outboundQuote.pricing_rule_id,
    pricing_rule_name:
      outboundQuote.pricing_rule_name || outboundQuote.route_label,
    route_mode: outboundQuote.route_mode,
    route_label: outboundQuote.route_label,
    pricing_source: outboundQuote.pricing_source,
    pricing_breakdown: {
      vehicle_label: outboundQuote.vehicle,
      start_price: outboundQuote.breakdown.start,
      min_price: outboundQuote.min_price,
      outbound_distance_miles: outbound.distance_miles,
      outbound_duration_minutes: outbound.duration_minutes,
      outbound_fare: outbound.fare,
      return_distance_miles: returnLeg?.distance_miles ?? 0,
      return_duration_minutes: returnLeg?.duration_minutes ?? 0,
      return_fare: returnLeg?.fare ?? 0,
      is_round_trip: Boolean(returnLeg),
      final_fare: totalFare,
    },
    pickup_latitude: outbound.pickup_latitude,
    pickup_longitude: outbound.pickup_longitude,
    dropoff_latitude: outbound.dropoff_latitude,
    dropoff_longitude: outbound.dropoff_longitude,
    distance_source: distanceSource,
    currency: "GBP",
    stops,
    outbound,
    return_leg: returnLeg,
  };
}

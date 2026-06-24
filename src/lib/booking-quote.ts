import type { SupabaseClient } from "@supabase/supabase-js";

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

interface RuleVehiclePricing {
  enabled?: boolean;
  min_price?: number | string;
  start_price?: number | string;
  waiting_price?: number | string;
  base_mile_price?: number | string;
  mile_tier_prices?: Record<string, number | string>;
  base_minute_price?: number | string;
  minute_tier_prices?: Record<string, number | string>;
}

interface RuleTier {
  id?: string;
  after_miles?: number | string;
  after_minutes?: number | string;
}

interface PricingRuleRow {
  id: string;
  rule_name?: string | null;
  rule_priority?: number | string | null;
  apply_web_booker?: boolean | null;
  pickup_area?: string | null;
  dropoff_area?: string | null;
  vehicles?: Record<string, RuleVehiclePricing> | null;
  mile_tiers?: RuleTier[] | null;
  minute_tiers?: RuleTier[] | null;
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

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  if (!needle.trim()) return true;
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

function vehicleCandidates(vehicleName: string): string[] {
  const candidates = new Set<string>([vehicleName]);
  const normalized = normalizeLabel(vehicleName);

  if (normalized.includes("saloon")) {
    candidates.add("Saloon");
    candidates.add("Saloon Car");
  }
  if (normalized.includes("peoplecarrier") || normalized.includes("carrier")) {
    candidates.add("People Carrier");
  }
  if (normalized.includes("minibus")) {
    candidates.add("Minibus");
    candidates.add("8 Seater Minibus");
  }

  return [...candidates];
}

function findVehiclePricing(
  vehicles: Record<string, RuleVehiclePricing> | null | undefined,
  vehicleName: string
): { label: string; pricing: RuleVehiclePricing } | null {
  if (!vehicles) return null;

  const entries = Object.entries(vehicles);
  const wanted = vehicleCandidates(vehicleName).map(normalizeLabel);

  for (const [label, pricing] of entries) {
    const normalizedLabel = normalizeLabel(label);
    const matched = wanted.some(
      (candidate) =>
        candidate === normalizedLabel ||
        candidate.includes(normalizedLabel) ||
        normalizedLabel.includes(candidate)
    );
    if (matched) return { label, pricing };
  }

  return null;
}

function resolveTierRate(
  metricValue: number,
  baseRate: number,
  tiers: RuleTier[] | null | undefined,
  tierPrices: Record<string, number | string> | null | undefined,
  thresholdField: "after_miles" | "after_minutes"
): number {
  if (!tiers?.length || !tierPrices) return baseRate;

  const resolved = tiers
    .map((tier) => ({
      threshold: toNumber(tier[thresholdField], NaN),
      price: toNumber(tier.id ? tierPrices[tier.id] : undefined, NaN),
    }))
    .filter((tier) => Number.isFinite(tier.threshold) && Number.isFinite(tier.price))
    .sort((a, b) => a.threshold - b.threshold);

  let rate = baseRate;
  for (const tier of resolved) {
    if (metricValue >= tier.threshold) {
      rate = tier.price;
    }
  }
  return rate;
}

function ruleScore(rule: PricingRuleRow, pickup: string, dropoff: string): number {
  const pickupArea = rule.pickup_area?.trim() ?? "";
  const dropoffArea = rule.dropoff_area?.trim() ?? "";

  if (pickupArea && !containsCaseInsensitive(pickup, pickupArea)) return -1;
  if (dropoffArea && !containsCaseInsensitive(dropoff, dropoffArea)) return -1;

  let score = toNumber(rule.rule_priority, 0) * 10;
  if (pickupArea) score += 2;
  if (dropoffArea) score += 2;
  if (!pickupArea && !dropoffArea) score += 1;
  return score;
}

function choosePricingRule(
  rules: PricingRuleRow[],
  pickup: string,
  dropoff: string
): PricingRuleRow | null {
  const eligible = rules.filter((rule) => rule.apply_web_booker !== false);
  if (!eligible.length) return null;

  const scored = eligible
    .map((rule) => ({ rule, score: ruleScore(rule, pickup, dropoff) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length) return scored[0].rule;

  // Fallback: highest priority web rule if area matching was too strict.
  return eligible.sort(
    (a, b) => toNumber(b.rule_priority, 0) - toNumber(a.rule_priority, 0)
  )[0];
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

interface VehiclePricingResolved {
  startPrice: number;
  minPrice: number;
  baseMilePrice: number;
  baseMinutePrice: number;
}

async function computeLeg(
  pickup: string,
  dropoff: string,
  stops: string[],
  apiKey: string,
  rule: PricingRuleRow,
  pricing: RuleVehiclePricing,
  resolved: VehiclePricingResolved
): Promise<QuoteLegResult> {
  const points = [pickup, ...stops, dropoff];
  const route = await getRouteMetrics(points, apiKey);

  const mileRate = resolveTierRate(
    route.distanceMiles,
    resolved.baseMilePrice,
    rule.mile_tiers,
    pricing.mile_tier_prices,
    "after_miles"
  );
  const minuteRate = resolveTierRate(
    route.durationMinutes,
    resolved.baseMinutePrice,
    rule.minute_tiers,
    pricing.minute_tier_prices,
    "after_minutes"
  );

  const subtotal =
    resolved.startPrice +
    route.distanceMiles * mileRate +
    route.durationMinutes * minuteRate;
  const fare = Math.max(subtotal, resolved.minPrice);

  return {
    pickup,
    dropoff,
    stops,
    distance_miles: round(route.distanceMiles, 2),
    duration_minutes: Math.max(1, Math.round(route.durationMinutes)),
    fare: round(fare, 2),
    mile_rate: round(mileRate, 4),
    minute_rate: round(minuteRate, 4),
    pickup_latitude: route.pickupCoordinates?.lat ?? null,
    pickup_longitude: route.pickupCoordinates?.lng ?? null,
    dropoff_latitude: route.dropoffCoordinates?.lat ?? null,
    dropoff_longitude: route.dropoffCoordinates?.lng ?? null,
    distance_source: route.source,
  };
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

  const { data: rulesData, error: rulesError } = await supabase
    .from("pricing_rules")
    .select("*")
    .eq("apply_web_booker", true);

  if (rulesError) {
    throw new Error(`Failed to load pricing rules: ${rulesError.message}`);
  }

  const rules = (rulesData ?? []) as PricingRuleRow[];
  const selectedRule = choosePricingRule(rules, pickup, dropoff);
  if (!selectedRule) {
    throw new Error("No web-booker pricing rule is configured.");
  }

  const vehicleMatch = findVehiclePricing(selectedRule.vehicles, payload.vehicle);
  if (!vehicleMatch) {
    throw new Error(`Pricing for vehicle "${payload.vehicle}" is not configured.`);
  }

  if (vehicleMatch.pricing.enabled === false) {
    throw new Error(`Vehicle "${vehicleMatch.label}" is disabled in pricing rules.`);
  }

  const resolved: VehiclePricingResolved = {
    startPrice: toNumber(vehicleMatch.pricing.start_price, 0),
    minPrice: toNumber(vehicleMatch.pricing.min_price, 0),
    baseMilePrice: toNumber(vehicleMatch.pricing.base_mile_price, 0),
    baseMinutePrice: toNumber(vehicleMatch.pricing.base_minute_price, 0),
  };

  const outbound = await computeLeg(
    pickup,
    dropoff,
    stops,
    apiKey,
    selectedRule,
    vehicleMatch.pricing,
    resolved
  );

  let returnLeg: QuoteLegResult | null = null;
  if (payload.return_journey) {
    const returnPickup = (payload.return_pickup ?? dropoff).trim();
    const returnDropoff = (payload.return_dropoff ?? pickup).trim();
    const returnStops = (payload.return_stops ?? [])
      .map((stop) => stop.trim())
      .filter(Boolean);

    returnLeg = await computeLeg(
      returnPickup,
      returnDropoff,
      returnStops,
      apiKey,
      selectedRule,
      vehicleMatch.pricing,
      resolved
    );
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
    pricing_rule_id: selectedRule.id ?? null,
    pricing_rule_name: selectedRule.rule_name ?? null,
    pricing_breakdown: {
      vehicle_label: vehicleMatch.label,
      start_price: round(resolved.startPrice, 2),
      min_price: round(resolved.minPrice, 2),
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

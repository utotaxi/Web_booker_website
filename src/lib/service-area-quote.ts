import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-area fare pricing for the web booker.
 *
 * Circle check (base service area, `area_type === "circle"`):
 *  - Inside: both pickup and drop-off are within the circle radius.
 *    Fare uses `pricing_rules` and bills pickup → drop-off only.
 *  - Inbound: pickup is outside the circle, drop-off is inside
 *    (elsewhere → service area). Fare uses `pricing_rules` and bills
 *    pickup → drop-off only — no dead mileage from the base.
 *  - Outbound / beyond: pickup is inside and drop-off is outside, or both
 *    points are outside (or no circle is configured). Fare uses
 *    `service_area_base_pricing` and bills base → pickup → drop-off.
 *
 * A fare can only be produced when the matching table has a web-booker rule;
 * otherwise a `PricingUnavailableError` is thrown and the caller blocks
 * booking with "Pricing unavailable — contact dispatch".
 */

export type LatLng = { lat: number; lng: number };

export type RouteMode =
  | "inside_pickup_dropoff"
  | "inbound_pickup_dropoff"
  | "outside_base_pickup_dropoff";

export const INSIDE_CIRCLE_CALCULATION = "Pickup Address → Drop-off Address";
export const INBOUND_CIRCLE_CALCULATION = "Pickup Address → Drop-off Address";
export const OUTSIDE_CIRCLE_CALCULATION =
  "Base Address → Pickup Address → Drop-off Address";

/** True when the trip is billed pickup → drop-off from `pricing_rules`. */
export function usesPricingRulesTable(mode: RouteMode): boolean {
  return mode === "inside_pickup_dropoff" || mode === "inbound_pickup_dropoff";
}

export const BASE_SERVICE_AREA_MARKER = "Role: Base";
export const METERS_PER_MILE = 1609.34;

export const PRICING_UNAVAILABLE = "Pricing unavailable — contact dispatch";

export class PricingUnavailableError extends Error {
  constructor(message = PRICING_UNAVAILABLE) {
    super(message);
    this.name = "PricingUnavailableError";
  }
}

interface ServiceAreaRow {
  id?: string;
  name?: string | null;
  description?: string | null;
  area_type?: string | null;
  coordinates?: [number, number][] | null;
  radius_meters?: number | null;
}

interface MileTier {
  id?: string | null;
  after_miles?: number | string | null;
}

interface MinuteTier {
  id?: string | null;
  after_minutes?: number | string | null;
}

interface PricingRuleRow {
  id?: string;
  rule_type?: string | null;
  rule_name?: string | null;
  service_area_id?: string | null;
  apply_web_booker?: boolean | null;
  vehicles?: Record<string, unknown> | null;
  mile_tiers?: MileTier[] | null;
  minute_tiers?: MinuteTier[] | null;
}

interface BasePricingRow {
  id?: string;
  rule_name?: string | null;
  service_area_id?: string | null;
  calculation?: string | null;
  apply_web_booker?: boolean | null;
  vehicles?: Record<string, unknown> | null;
  mile_tiers?: MileTier[] | null;
  minute_tiers?: MinuteTier[] | null;
}

export type PricingSource = "pricing_rules" | "service_area_base_pricing";

export function isServiceAreaPricingRule(
  rule: { rule_type?: string | null } | null | undefined
): boolean {
  return (rule?.rule_type || "") === "Service area";
}

function appliesToWebBooker(row: {
  apply_web_booker?: boolean | null;
}): boolean {
  return row.apply_web_booker !== false;
}

export function findMainPricingRule<
  T extends { rule_type?: string | null; apply_web_booker?: boolean | null }
>(rules: T[]): T | null {
  return (
    rules.find((r) => !isServiceAreaPricingRule(r) && appliesToWebBooker(r)) ||
    null
  );
}

export function findPricingRuleForServiceArea<
  T extends {
    rule_type?: string | null;
    service_area_id?: string | null;
    apply_web_booker?: boolean | null;
  }
>(rules: T[], serviceAreaId?: string | null): T | null {
  const candidates = rules.filter(
    (r) => isServiceAreaPricingRule(r) && appliesToWebBooker(r)
  );
  if (serviceAreaId) {
    const linked = candidates.find((r) => r.service_area_id === serviceAreaId);
    if (linked) return linked;
  }
  return candidates.find((r) => !r.service_area_id) || null;
}

export function findBasePricingForServiceArea<
  T extends {
    service_area_id?: string | null;
    calculation?: string | null;
    apply_web_booker?: boolean | null;
  }
>(rows: T[], serviceAreaId?: string | null): T | null {
  const web = rows.filter(appliesToWebBooker);
  const pool = web.length ? web : rows;
  if (serviceAreaId) {
    const linked = pool.find((r) => r.service_area_id === serviceAreaId);
    if (linked) return linked;
  }
  return (
    pool.find((r) => (r.calculation || "") === "base_pickup_dropoff") ||
    pool[0] ||
    null
  );
}

export function metersToMiles(meters: number): number {
  return meters / METERS_PER_MILE;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function isWithinCircle(
  point: LatLng,
  center: LatLng,
  radiusMiles: number
): boolean {
  if (!radiusMiles || radiusMiles <= 0) return false;
  return haversineMiles(point, center) <= radiusMiles;
}

export function resolveRouteMode(
  pickup: LatLng,
  dropoff: LatLng,
  center: LatLng | null,
  radiusMiles: number
): RouteMode {
  if (!center || radiusMiles <= 0) return "outside_base_pickup_dropoff";
  const pickupIn = isWithinCircle(pickup, center, radiusMiles);
  const dropoffIn = isWithinCircle(dropoff, center, radiusMiles);
  if (pickupIn && dropoffIn) return "inside_pickup_dropoff";
  // Elsewhere → service area: inward trip, no dead-head from the base.
  if (!pickupIn && dropoffIn) return "inbound_pickup_dropoff";
  return "outside_base_pickup_dropoff";
}

export type RouteLeg = {
  from: "base" | "pickup";
  to: "pickup" | "dropoff";
  miles: number;
};

export function billedRoute(params: {
  pickup: LatLng;
  dropoff: LatLng;
  center: LatLng | null;
  radiusMiles: number;
}): { miles: number; mode: RouteMode; legs: RouteLeg[] } {
  const { pickup, dropoff, center, radiusMiles } = params;
  const mode = resolveRouteMode(pickup, dropoff, center, radiusMiles);
  const pickupToDropoff = haversineMiles(pickup, dropoff);

  if (usesPricingRulesTable(mode)) {
    return {
      miles: pickupToDropoff,
      mode,
      legs: [{ from: "pickup", to: "dropoff", miles: pickupToDropoff }],
    };
  }

  const baseToPickup = center ? haversineMiles(center, pickup) : 0;
  return {
    miles: baseToPickup + pickupToDropoff,
    mode,
    legs: [
      ...(center
        ? [{ from: "base" as const, to: "pickup" as const, miles: baseToPickup }]
        : []),
      { from: "pickup", to: "dropoff", miles: pickupToDropoff },
    ],
  };
}

export function describeRouteMode(mode: RouteMode): string {
  if (mode === "inbound_pickup_dropoff") return INBOUND_CIRCLE_CALCULATION;
  return mode === "inside_pickup_dropoff"
    ? INSIDE_CIRCLE_CALCULATION
    : OUTSIDE_CIRCLE_CALCULATION;
}

function parseBaseAreaDescription(
  description?: string | null
): { isBase: boolean } {
  const text = description || "";
  return { isBase: text.includes(BASE_SERVICE_AREA_MARKER) };
}

export function findBaseServiceArea<T extends ServiceAreaRow>(
  areas: T[]
): T | undefined {
  return (
    areas.find(
      (a) =>
        a.area_type === "circle" && parseBaseAreaDescription(a.description).isBase
    ) || areas.find((a) => a.area_type === "circle")
  );
}

function applyTieredRate(
  distance: number,
  baseRate: number,
  tiers: { after: number; rate: number }[]
): number {
  if (distance <= 0) return 0;
  const sorted = [...tiers]
    .filter((t) => t.after > 0)
    .sort((a, b) => a.after - b.after);
  if (sorted.length === 0) return distance * baseRate;

  let remaining = distance;
  let prev = 0;
  let total = 0;
  let currentRate = baseRate;

  for (const tier of sorted) {
    const chunk = Math.min(remaining, Math.max(0, tier.after - prev));
    if (chunk > 0) {
      total += chunk * currentRate;
      remaining -= chunk;
    }
    currentRate = tier.rate;
    prev = tier.after;
    if (remaining <= 0) break;
  }

  if (remaining > 0) total += remaining * currentRate;
  return total;
}

function num(value: unknown, fallback = 0): number {
  const parsed = parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveVehicleName(vehicleType?: string | null): string {
  const raw = (vehicleType || "").toLowerCase().trim();
  if (raw.includes("mini") || raw.includes("bus")) return "Minibus";
  if (
    raw.includes("people") ||
    raw.includes("mpv") ||
    raw.includes("carrier") ||
    raw.includes("xl")
  ) {
    return "People Carrier";
  }
  return "Saloon";
}

export function calculateFareFromRule(params: {
  miles: number;
  minutes?: number;
  vehicleType?: string | null;
  vehicles: Record<string, unknown>;
  mileTiers?: MileTier[];
  minuteTiers?: MinuteTier[];
}): {
  price: number;
  vehicle: string;
  start: number;
  mileage: number;
  time: number;
  minPrice: number;
} {
  const vehicle = resolveVehicleName(params.vehicleType);
  const raw = (params.vehicles?.[vehicle] ||
    params.vehicles?.[vehicle.toLowerCase()] ||
    {}) as Record<string, unknown>;
  const start = num(raw.start_price);
  const minPrice = num(raw.min_price);
  const mileRate = num(raw.base_mile_price);
  const minuteRate = num(raw.base_minute_price);
  const mileTierPrices = (raw.mile_tier_prices || {}) as Record<string, unknown>;
  const minuteTierPrices = (raw.minute_tier_prices || {}) as Record<
    string,
    unknown
  >;

  const mileTiers = (params.mileTiers || []).map((tier) => ({
    after: num(tier.after_miles),
    rate: num(mileTierPrices[tier.id ?? ""], mileRate),
  }));
  const minuteTiers = (params.minuteTiers || []).map((tier) => ({
    after: num(tier.after_minutes),
    rate: num(minuteTierPrices[tier.id ?? ""], minuteRate),
  }));

  const mileage = applyTieredRate(params.miles, mileRate, mileTiers);
  const time = applyTieredRate(params.minutes || 0, minuteRate, minuteTiers);
  const price = Math.max(minPrice, start + mileage + time);

  return {
    price: Math.round(price * 100) / 100,
    vehicle,
    start: Math.round(start * 100) / 100,
    mileage: Math.round(mileage * 100) / 100,
    time: Math.round(time * 100) / 100,
    minPrice: Math.round(minPrice * 100) / 100,
  };
}

function round(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export interface ServiceAreaQuote {
  price: number;
  billed_miles: number;
  route_mode: RouteMode;
  route_label: string;
  pricing_source: PricingSource;
  pricing_rule_id: string | null;
  pricing_rule_name: string | null;
  vehicle: string;
  min_price: number;
  breakdown: { start: number; mileage: number; time: number };
  base: {
    name: string | undefined;
    latitude: number;
    longitude: number;
    radius_miles: number;
  } | null;
}

async function loadQuoteInputs(supabase: SupabaseClient) {
  const [
    { data: areas, error: areasError },
    { data: rules, error: rulesError },
    { data: basePricing, error: basePricingError },
  ] = await Promise.all([
    supabase
      .from("service_areas")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("pricing_rules")
      .select("*")
      .order("created_at", { ascending: false }),
    supabase
      .from("service_area_base_pricing")
      .select("*")
      .order("created_at", { ascending: false }),
  ]);

  if (areasError) {
    throw new PricingUnavailableError();
  }

  return {
    areas: (areas ?? []) as ServiceAreaRow[],
    rules: rulesError ? [] : ((rules ?? []) as PricingRuleRow[]),
    basePricing: basePricingError
      ? []
      : ((basePricing ?? []) as BasePricingRow[]),
  };
}

/**
 * Price a single leg (pickup → dropoff).
 *
 * Inside the circle, or inbound (elsewhere → service area) → `pricing_rules`
 * with pickup → drop-off miles.
 * Outbound / beyond the circle → `service_area_base_pricing` with
 * base → pickup → drop-off miles.
 * Throws `PricingUnavailableError` when the required table has no rule.
 */
export async function quoteServiceAreaLeg(
  supabase: SupabaseClient,
  params: {
    pickup: LatLng;
    dropoff: LatLng;
    minutes?: number;
    vehicleType?: string | null;
  }
): Promise<ServiceAreaQuote> {
  const { areas, rules, basePricing } = await loadQuoteInputs(supabase);

  const baseArea = findBaseServiceArea(areas);
  const center = baseArea?.coordinates?.[0]
    ? { lat: baseArea.coordinates[0][0], lng: baseArea.coordinates[0][1] }
    : null;
  const radiusMiles = baseArea?.radius_meters
    ? metersToMiles(baseArea.radius_meters)
    : 0;

  const route = billedRoute({
    pickup: params.pickup,
    dropoff: params.dropoff,
    center,
    radiusMiles,
  });

  const usePricingRules = usesPricingRulesTable(route.mode);
  const selected = usePricingRules
    ? findPricingRuleForServiceArea(rules, baseArea?.id) ||
      findMainPricingRule(rules)
    : findBasePricingForServiceArea(basePricing, baseArea?.id);
  if (!selected) {
    throw new PricingUnavailableError();
  }

  const fare = calculateFareFromRule({
    miles: route.miles,
    minutes: params.minutes ?? 0,
    vehicleType: params.vehicleType ?? "economy",
    vehicles: (selected.vehicles || {}) as Record<string, unknown>,
    mileTiers: selected.mile_tiers || [],
    minuteTiers: selected.minute_tiers || [],
  });

  return {
    price: fare.price,
    billed_miles: round(route.miles),
    route_mode: route.mode,
    route_label: describeRouteMode(route.mode),
    pricing_source: usePricingRules
      ? "pricing_rules"
      : "service_area_base_pricing",
    pricing_rule_id: selected.id ?? null,
    pricing_rule_name: selected.rule_name ?? null,
    vehicle: fare.vehicle,
    min_price: fare.minPrice,
    breakdown: { start: fare.start, mileage: fare.mileage, time: fare.time },
    base:
      center && radiusMiles > 0
        ? {
            name: baseArea?.name ?? undefined,
            latitude: center.lat,
            longitude: center.lng,
            radius_miles: round(radiusMiles),
          }
        : null,
  };
}
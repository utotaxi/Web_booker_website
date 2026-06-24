import type { VehicleType } from "@/types/booking";

export interface VehicleBookingLimit {
  maxPassengers: number;
  maxLuggage: number;
  displayName: string;
  backendType: "saloon" | "people_carrier" | "minibus";
}

export const VEHICLE_BOOKING_LIMITS: Record<VehicleType, VehicleBookingLimit> = {
  saloon: {
    maxPassengers: 3,
    maxLuggage: 3,
    displayName: "Saloon Car",
    backendType: "saloon",
  },
  "people-carrier": {
    maxPassengers: 5,
    maxLuggage: 5,
    displayName: "People Carrier",
    backendType: "people_carrier",
  },
  minibus: {
    maxPassengers: 8,
    maxLuggage: 8,
    displayName: "8 Seater Minibus",
    backendType: "minibus",
  },
};

export function normalizeVehicleIdFromLabel(vehicle?: string): VehicleType {
  const value = (vehicle ?? "").toLowerCase();
  if (value.includes("people")) return "people-carrier";
  if (value.includes("mini")) return "minibus";
  return "saloon";
}

export function isVehicleIdCompatible(
  vehicleId: VehicleType,
  passengers: number,
  luggage: number
): boolean {
  const limits = VEHICLE_BOOKING_LIMITS[vehicleId];
  return passengers <= limits.maxPassengers && luggage <= limits.maxLuggage;
}

export function getMostCompatibleVehicleId(
  passengers: number,
  luggage: number
): VehicleType {
  if (isVehicleIdCompatible("saloon", passengers, luggage)) return "saloon";
  if (isVehicleIdCompatible("people-carrier", passengers, luggage)) {
    return "people-carrier";
  }
  return "minibus";
}

export function resolveVehicleSelection(
  requestedVehicleLabel: string | undefined,
  passengers: number,
  luggage: number
): {
  vehicleId: VehicleType;
  displayName: string;
  backendType: "saloon" | "people_carrier" | "minibus";
} {
  const requestedId = normalizeVehicleIdFromLabel(requestedVehicleLabel);
  const resolvedId = isVehicleIdCompatible(requestedId, passengers, luggage)
    ? requestedId
    : getMostCompatibleVehicleId(passengers, luggage);
  const limits = VEHICLE_BOOKING_LIMITS[resolvedId];

  return {
    vehicleId: resolvedId,
    displayName: limits.displayName,
    backendType: limits.backendType,
  };
}

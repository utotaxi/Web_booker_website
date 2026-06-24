export type VehicleType = "saloon" | "people-carrier" | "minibus";

export interface VehicleOption {
  id: VehicleType;
  name: string;
  shortName: string;
  description: string;
  maxPassengers: number;
  maxLuggage: number;
  handLuggagePassengers?: number;
}

export const VEHICLE_OPTIONS: VehicleOption[] = [
  {
    id: "saloon",
    name: "Saloon Car",
    shortName: "Saloon",
    description:
      "Up to 3 passengers + 3 baggage, or 4 passengers + hand luggage",
    maxPassengers: 4,
    maxLuggage: 3,
    handLuggagePassengers: 4,
  },
  {
    id: "people-carrier",
    name: "People Carrier",
    shortName: "People Carrier",
    description:
      "Up to 5 passengers + 5 baggage, or 6 passengers + hand luggage",
    maxPassengers: 6,
    maxLuggage: 5,
    handLuggagePassengers: 6,
  },
  {
    id: "minibus",
    name: "8 Seater Minibus",
    shortName: "Minibus",
    description: "Up to 8 passengers + 8 baggage",
    maxPassengers: 8,
    maxLuggage: 8,
  },
];

export const MIN_BOOKING_HOURS = 10;

export interface BookingFormData {
  pickup: string;
  dropoff: string;
  date: string;
  hour: string;
  minute: string;
  vehicle: VehicleType;
  passengers: number;
  luggage: number;
}

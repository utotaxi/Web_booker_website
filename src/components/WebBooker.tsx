"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarIcon,
  CarIcon,
  ClockIcon,
  CloseIcon,
  FlagIcon,
  LocationPinIcon,
  LuggageIcon,
  PlusIcon,
  RouteIcon,
  StopIcon,
  UsersIcon,
  VanIcon,
} from "@/components/icons";
import {
  formatPickupDisplay,
  getDefaultPickupValues,
  toPickupISODateTime,
  validatePickupDateTime,
} from "@/lib/booking-validation";
import LocationAutocomplete from "@/components/LocationAutocomplete";
import {
  MIN_BOOKING_HOURS,
  VEHICLE_OPTIONS,
  type VehicleType,
} from "@/types/booking";
import {
  getMostCompatibleVehicleId,
  isVehicleIdCompatible,
  VEHICLE_BOOKING_LIMITS,
} from "@/lib/vehicle-compatibility";

const HOURS = Array.from({ length: 24 }, (_, i) =>
  String(i).padStart(2, "0")
);
const MINUTES = [
  "00",
  "05",
  "10",
  "15",
  "20",
  "25",
  "30",
  "35",
  "40",
  "45",
  "50",
  "55",
];
const MAX_PASSENGERS = VEHICLE_BOOKING_LIMITS.minibus.maxPassengers;
const MAX_LUGGAGE = VEHICLE_BOOKING_LIMITS.minibus.maxLuggage;
const MAX_STOPS = 8;

const TRUST_POINTS = [
  "+10,000 passenger transferred",
  "Instant confirmation",
  "All inclusive pricing",
  "Secure payments by card",
];

interface QuoteLegPreview {
  distance_miles: number;
  duration_minutes: number;
  fare: number;
}

interface BookingQuotePreview {
  estimated_fare: number;
  distance_miles: number;
  duration_minutes: number;
  pricing_rule_name: string | null;
  distance_source: "google_directions" | "haversine_estimate";
  currency: "GBP";
  outbound?: QuoteLegPreview;
  return_leg?: QuoteLegPreview | null;
}

type BookerStep = "booking" | "review" | "personal" | "submitted";

interface PersonalDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  bookingForSomeoneElse: boolean;
  flightInfo: string;
  arrivalFrom: string;
  additionalNote: string;
}

function IconBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-l-md bg-navy text-white">
      {children}
    </div>
  );
}

function FieldRow({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex rounded-md border border-gray-300 bg-white shadow-sm">
      <IconBox>{icon}</IconBox>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

function StopRow({
  idPrefix,
  index,
  value,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  index: number;
  value: string;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-stretch rounded-md border border-gray-200 bg-white shadow-sm">
      <IconBox>
        <StopIcon />
      </IconBox>
      <div className="flex min-w-0 flex-1 items-center">
        <LocationAutocomplete
          id={`${idPrefix}-${index}`}
          value={value}
          onChange={onChange}
          placeholder={`Stop ${index + 1} - Enter location`}
        />
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove stop ${index + 1}`}
        title="Remove stop"
        className="flex w-11 shrink-0 items-center justify-center rounded-r-md text-gray-400 transition hover:bg-red-50 hover:text-red-600"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

export default function WebBooker() {
  const defaults = useMemo(() => getDefaultPickupValues(), []);

  const [step, setStep] = useState<BookerStep>("booking");
  const [pickup, setPickup] = useState("");
  const [dropoff, setDropoff] = useState("");
  const [date, setDate] = useState(defaults.date);
  const [hour, setHour] = useState(defaults.hour);
  const [minute, setMinute] = useState(defaults.minute);
  const [vehicle, setVehicle] = useState<VehicleType>("saloon");
  const [passengers, setPassengers] = useState(1);
  const [luggage, setLuggage] = useState(0);
  const [showReturn, setShowReturn] = useState(false);
  const [stops, setStops] = useState<string[]>([]);
  const [returnPickup, setReturnPickup] = useState("");
  const [returnDropoff, setReturnDropoff] = useState("");
  const [returnDate, setReturnDate] = useState(defaults.date);
  const [returnHour, setReturnHour] = useState(defaults.hour);
  const [returnMinute, setReturnMinute] = useState(defaults.minute);
  const [returnStops, setReturnStops] = useState<string[]>([]);
  const [returnPassengers, setReturnPassengers] = useState(1);
  const [returnLuggage, setReturnLuggage] = useState(0);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quote, setQuote] = useState<BookingQuotePreview | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [confirmedQuote, setConfirmedQuote] = useState<BookingQuotePreview | null>(
    null
  );
  const [personal, setPersonal] = useState<PersonalDetails>({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    bookingForSomeoneElse: false,
    flightInfo: "",
    arrivalFrom: "",
    additionalNote: "",
  });
  const [personalErrors, setPersonalErrors] = useState<Record<string, string>>({});

  const selectedVehicle = VEHICLE_OPTIONS.find((v) => v.id === vehicle)!;
  const pickupDisplay = formatPickupDisplay(date, hour, minute);

  // The single selected vehicle must fit the busiest leg, so compatibility is
  // based on the maximum passenger/luggage count across outbound and return.
  const effectivePassengers = showReturn
    ? Math.max(passengers, returnPassengers)
    : passengers;
  const effectiveLuggage = showReturn
    ? Math.max(luggage, returnLuggage)
    : luggage;

  const mostCompatibleVehicleId = useMemo(
    () => getMostCompatibleVehicleId(effectivePassengers, effectiveLuggage),
    [effectivePassengers, effectiveLuggage]
  );

  const timeValidation = useMemo(
    () => validatePickupDateTime(date, hour, minute),
    [date, hour, minute]
  );

  const activeStops = useMemo(
    () => stops.map((stop) => stop.trim()).filter(Boolean),
    [stops]
  );

  const activeReturnStops = useMemo(
    () => returnStops.map((stop) => stop.trim()).filter(Boolean),
    [returnStops]
  );

  const returnTimeValidation = useMemo(
    () => validatePickupDateTime(returnDate, returnHour, returnMinute),
    [returnDate, returnHour, returnMinute]
  );

  const returnAfterOutbound = useMemo(() => {
    const outboundIso = toPickupISODateTime(date, hour, minute);
    const returnIso = toPickupISODateTime(returnDate, returnHour, returnMinute);
    if (!outboundIso || !returnIso) return true;
    return new Date(returnIso).getTime() > new Date(outboundIso).getTime();
  }, [date, hour, minute, returnDate, returnHour, returnMinute]);

  const returnReady =
    !showReturn ||
    (!!returnPickup.trim() &&
      !!returnDropoff.trim() &&
      returnTimeValidation.valid &&
      returnAfterOutbound);

  const returnError = useMemo(() => {
    if (!showReturn) return null;
    if (!returnPickup.trim() || !returnDropoff.trim()) {
      return "Please enter return pickup and dropoff locations.";
    }
    if (!returnTimeValidation.valid) {
      return returnTimeValidation.message ?? "Invalid return time.";
    }
    if (!returnAfterOutbound) {
      return "Return time must be after the outbound pickup time.";
    }
    return null;
  }, [
    showReturn,
    returnPickup,
    returnDropoff,
    returnTimeValidation.valid,
    returnTimeValidation.message,
    returnAfterOutbound,
  ]);

  const passengerOptions = useMemo(
    () => Array.from({ length: MAX_PASSENGERS }, (_, i) => i + 1),
    []
  );

  const luggageOptions = useMemo(
    () => Array.from({ length: MAX_LUGGAGE + 1 }, (_, i) => i),
    []
  );

  useEffect(() => {
    if (!isVehicleIdCompatible(vehicle, effectivePassengers, effectiveLuggage)) {
      setVehicle(mostCompatibleVehicleId);
      setQuote(null);
      setQuoteError(null);
      if (pickup.trim() && dropoff.trim() && timeValidation.valid) {
        setQuoteLoading(true);
      }
    }
  }, [
    vehicle,
    effectivePassengers,
    effectiveLuggage,
    mostCompatibleVehicleId,
    pickup,
    dropoff,
    timeValidation.valid,
  ]);

  useEffect(() => {
    if (!pickup.trim() || !dropoff.trim() || !timeValidation.valid || !returnReady) {
      setQuote(null);
      setQuoteError(null);
      setQuoteLoading(false);
      return;
    }

    const controller = new AbortController();
    setQuoteLoading(true);
    setQuoteError(null);

    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/bookings/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            pickup,
            dropoff,
            stops: activeStops,
            vehicle: selectedVehicle.name,
            passengers,
            luggage,
            return_journey: showReturn,
            return_pickup: showReturn ? returnPickup : undefined,
            return_dropoff: showReturn ? returnDropoff : undefined,
            return_stops: showReturn ? activeReturnStops : [],
            return_passengers: showReturn ? returnPassengers : undefined,
            return_luggage: showReturn ? returnLuggage : undefined,
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          setQuote(null);
          setQuoteError(data.error || "Could not calculate fare.");
          return;
        }

        setQuote((data.quote ?? null) as BookingQuotePreview | null);
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setQuote(null);
          setQuoteError("Could not calculate fare right now.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setQuoteLoading(false);
        }
      }
    }, 350);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    pickup,
    dropoff,
    activeStops,
    selectedVehicle.name,
    passengers,
    luggage,
    showReturn,
    returnReady,
    returnPickup,
    returnDropoff,
    activeReturnStops,
    returnPassengers,
    returnLuggage,
    timeValidation.valid,
  ]);

  const handleVehicleChange = (newVehicle: VehicleType) => {
    if (!isVehicleIdCompatible(newVehicle, effectivePassengers, effectiveLuggage))
      return;

    setVehicle(newVehicle);
    setQuote(null);
    setQuoteError(null);
    if (pickup.trim() && dropoff.trim() && timeValidation.valid) {
      setQuoteLoading(true);
    }
  };

  const removeStop = (index: number) => {
    setStops((prev) => prev.filter((_, i) => i !== index));
  };

  const removeReturnStop = (index: number) => {
    setReturnStops((prev) => prev.filter((_, i) => i !== index));
  };

  const toggleReturnJourney = () => {
    if (showReturn) {
      setShowReturn(false);
      return;
    }
    setReturnPickup((prev) => prev || dropoff);
    setReturnDropoff((prev) => prev || pickup);
    setReturnDate((prev) => prev || date);
    setReturnPassengers(passengers);
    setReturnLuggage(luggage);
    setShowReturn(true);
  };

  const canProceedFromBooking =
    !!pickup.trim() &&
    !!dropoff.trim() &&
    timeValidation.valid &&
    returnReady &&
    !!quote &&
    !quoteLoading &&
    !quoteError;

  const locationError =
    touched && (!pickup.trim() || !dropoff.trim())
      ? "Please enter both pickup and dropoff locations."
      : null;

  const validatePersonalDetails = (): boolean => {
    const errors: Record<string, string> = {};
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!personal.firstName.trim()) errors.firstName = "First name is required.";
    if (!personal.lastName.trim()) errors.lastName = "Last name is required.";
    if (!personal.email.trim()) errors.email = "Email is required.";
    else if (!emailPattern.test(personal.email.trim())) {
      errors.email = "Enter a valid email address.";
    }
    if (!personal.phone.trim()) errors.phone = "Phone number is required.";

    setPersonalErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const goToReview = (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setSaveError(null);

    if (!pickup.trim() || !dropoff.trim()) return;
    if (!timeValidation.valid) return;
    if (returnError) {
      setSaveError(returnError);
      return;
    }
    if (!quote || quoteLoading) {
      setSaveError("Please wait for fare calculation before continuing.");
      return;
    }
    if (quoteError) {
      setSaveError(quoteError);
      return;
    }

    setStep("review");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const goToPersonal = () => {
    if (!quote) {
      setSaveError("Fare is not ready yet. Please wait.");
      return;
    }
    setSaveError(null);
    setStep("personal");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleConfirmBooking = async () => {
    setSaveError(null);
    if (!validatePersonalDetails()) return;

    if (!quote) {
      setSaveError("Fare is not ready yet. Please recalculate and try again.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pickup,
          dropoff,
          stops: activeStops,
          pickup_date: date,
          pickup_time: `${hour}:${minute}`,
          pickup_datetime: toPickupISODateTime(date, hour, minute),
          vehicle: selectedVehicle.name,
          passengers,
          luggage,
          return_journey: showReturn,
          return_pickup: showReturn ? returnPickup : undefined,
          return_dropoff: showReturn ? returnDropoff : undefined,
          return_stops: showReturn ? activeReturnStops : [],
          return_passengers: showReturn ? returnPassengers : undefined,
          return_luggage: showReturn ? returnLuggage : undefined,
          return_date: showReturn ? returnDate : undefined,
          return_time: showReturn ? `${returnHour}:${returnMinute}` : undefined,
          return_datetime: showReturn
            ? toPickupISODateTime(returnDate, returnHour, returnMinute)
            : undefined,
          first_name: personal.firstName,
          last_name: personal.lastName,
          email: personal.email,
          phone_number: personal.phone,
          booking_for_someone_else: personal.bookingForSomeoneElse,
          flight_info: personal.flightInfo,
          arrival_from: personal.arrivalFrom,
          additional_note: personal.additionalNote,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setSaveError(data.error || "We couldn't save your booking. Please try again.");
        return;
      }

      setConfirmedQuote((data.quote ?? quote) as BookingQuotePreview | null);
      setStep("submitted");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch {
      setSaveError("Network error while saving your booking. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (step === "submitted") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="bg-navy px-6 py-4">
            <h2 className="text-lg font-semibold text-white">Booking Confirmed</h2>
          </div>
          <div className="space-y-4 p-6">
            <p className="text-gray-700">
              Your booking has been confirmed! Shortly you will receive updates about
              your driver assigned details.
              <br />
              Thank you for choosing us.
            </p>
            <div className="rounded-md bg-gray-50 p-4 text-sm text-gray-600">
              {(personal.firstName || personal.lastName) && (
                <p>
                  <strong>Name:</strong>{" "}
                  {`${personal.firstName} ${personal.lastName}`.trim()}
                </p>
              )}
              {personal.email && (
                <p><strong>Email:</strong> {personal.email}</p>
              )}
              {personal.phone && (
                <p><strong>Phone:</strong> {personal.phone}</p>
              )}
              <p><strong>Pickup:</strong> {pickup}</p>
              {activeStops.length > 0 && (
                <p><strong>Additional stops:</strong> {activeStops.join(", ")}</p>
              )}
              <p><strong>Dropoff:</strong> {dropoff}</p>
              <p><strong>Date & Time:</strong> {pickupDisplay}</p>
              <p><strong>Vehicle:</strong> {selectedVehicle.name}</p>
              <p><strong>Passengers:</strong> {passengers}</p>
              <p><strong>Luggage:</strong> {luggage}</p>
              {showReturn && (
                <>
                  <p className="pt-1"><strong>Return pickup:</strong> {returnPickup}</p>
                  {activeReturnStops.length > 0 && (
                    <p><strong>Return stops:</strong> {activeReturnStops.join(", ")}</p>
                  )}
                  <p><strong>Return dropoff:</strong> {returnDropoff}</p>
                  <p>
                    <strong>Return date & time:</strong>{" "}
                    {formatPickupDisplay(returnDate, returnHour, returnMinute)}
                  </p>
                  <p><strong>Return passengers:</strong> {returnPassengers}</p>
                  <p><strong>Return luggage:</strong> {returnLuggage}</p>
                </>
              )}
              {confirmedQuote && (
                <>
                  <p className="pt-1"><strong>Estimated Fare:</strong> £{confirmedQuote.estimated_fare.toFixed(2)}{confirmedQuote.return_leg ? " (return trip)" : ""}</p>
                  <p>
                    <strong>Total distance:</strong> {confirmedQuote.distance_miles.toFixed(2)} miles
                    {" · "}
                    <strong>Duration:</strong> {confirmedQuote.duration_minutes} mins
                  </p>
                </>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setStep("booking");
                setTouched(false);
                setConfirmedQuote(null);
                setSaveError(null);
                setPersonalErrors({});
                setShowReturn(false);
                setReturnStops([]);
                setReturnPassengers(1);
                setReturnLuggage(0);
                setStops([]);
              }}
              className="rounded-md bg-navy px-6 py-3 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-navy-dark"
            >
              Book Another Ride
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "review") {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-lg sm:p-6">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">
              Estimated Fare
            </p>
            <p className="mt-1 text-3xl font-bold text-emerald-800">
              £{(quote?.estimated_fare ?? 0).toFixed(2)}
            </p>
            <p className="mt-1 text-sm text-emerald-700">
              {(quote?.distance_miles ?? 0).toFixed(2)} miles · {quote?.duration_minutes ?? 0} mins
              {showReturn ? " · Return trip included" : ""}
            </p>
          </div>

          <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
            <h3 className="text-base font-semibold text-navy">Outbound Journey</h3>
            <div className="mt-3 space-y-1 text-sm text-gray-700">
              <p><strong>Pickup:</strong> {pickup}</p>
              {activeStops.length > 0 && (
                <p><strong>Stops:</strong> {activeStops.join(" → ")}</p>
              )}
              <p><strong>Dropoff:</strong> {dropoff}</p>
              <p><strong>Date & Time:</strong> {pickupDisplay}</p>
              <p><strong>Vehicle:</strong> {selectedVehicle.name}</p>
              <p><strong>Passengers:</strong> {passengers}</p>
              <p><strong>Luggage:</strong> {luggage}</p>
              {quote?.outbound && (
                <p>
                  <strong>Outbound fare:</strong> £{quote.outbound.fare.toFixed(2)}
                  {" · "}
                  {quote.outbound.distance_miles.toFixed(2)} miles
                </p>
              )}
            </div>
          </div>

          {showReturn && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <h3 className="text-base font-semibold text-navy">Return Journey</h3>
              <div className="mt-3 space-y-1 text-sm text-gray-700">
                <p><strong>Pickup:</strong> {returnPickup}</p>
                {activeReturnStops.length > 0 && (
                  <p><strong>Stops:</strong> {activeReturnStops.join(" → ")}</p>
                )}
                <p><strong>Dropoff:</strong> {returnDropoff}</p>
                <p>
                  <strong>Date & Time:</strong>{" "}
                  {formatPickupDisplay(returnDate, returnHour, returnMinute)}
                </p>
                <p><strong>Passengers:</strong> {returnPassengers}</p>
                <p><strong>Luggage:</strong> {returnLuggage}</p>
                {quote?.return_leg && (
                  <p>
                    <strong>Return fare:</strong> £{quote.return_leg.fare.toFixed(2)}
                    {" · "}
                    {quote.return_leg.distance_miles.toFixed(2)} miles
                  </p>
                )}
              </div>
            </div>
          )}

          {saveError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {saveError}
            </div>
          )}

          <div className="flex flex-wrap justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={() => setStep("booking")}
              className="rounded-md border border-gray-300 bg-white px-5 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Back To Booking Details
            </button>
            <button
              type="button"
              onClick={goToPersonal}
              className="rounded-md bg-navy px-6 py-2.5 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-navy-dark"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === "personal") {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-8">
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="space-y-4">
            <div className="rounded-xl border border-gray-200 bg-white shadow-lg">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
                <h3 className="text-base font-semibold text-navy">Your Transfer</h3>
                <button
                  type="button"
                  onClick={() => setStep("booking")}
                  className="text-xs font-semibold uppercase text-navy hover:underline"
                >
                  Edit
                </button>
              </div>
              <div className="space-y-3 px-4 py-4 text-sm text-gray-700">
                <p><strong>Pickup:</strong> {pickup}</p>
                <p><strong>Dropoff:</strong> {dropoff}</p>
                <p><strong>Date & Time:</strong> {pickupDisplay}</p>
                <p>
                  <strong>Distance:</strong> {(quote?.distance_miles ?? 0).toFixed(2)} miles
                </p>
                <p>
                  <strong>Duration:</strong> {quote?.duration_minutes ?? 0} mins
                </p>
                {activeStops.length > 0 && (
                  <p><strong>Stops:</strong> {activeStops.join(" → ")}</p>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-lg">
              <ul className="space-y-2 text-sm text-gray-700">
                {TRUST_POINTS.map((point) => (
                  <li key={point}>• {point}</li>
                ))}
              </ul>
            </div>
          </aside>

          <section className="rounded-xl border border-gray-200 bg-white shadow-lg">
            <div className="border-b border-gray-100 px-5 py-4">
              <h2 className="text-lg font-semibold text-navy">Personal Details</h2>
            </div>

            <div className="border-b border-gray-100 bg-gray-50 px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xl font-semibold text-navy">{selectedVehicle.name}</p>
                  <p className="mt-1 text-sm text-gray-600">
                    {passengers} passenger{passengers !== 1 ? "s" : ""} · {luggage} luggage
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-semibold uppercase text-gray-500">Total Price</p>
                  <p className="text-3xl font-bold text-navy">
                    £{(quote?.estimated_fare ?? 0).toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-4 px-5 py-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    First Name *
                  </label>
                  <input
                    type="text"
                    value={personal.firstName}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, firstName: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Enter your first name"
                  />
                  {personalErrors.firstName && (
                    <p className="mt-1 text-xs text-red-600">{personalErrors.firstName}</p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Last Name *
                  </label>
                  <input
                    type="text"
                    value={personal.lastName}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, lastName: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Enter your last name"
                  />
                  {personalErrors.lastName && (
                    <p className="mt-1 text-xs text-red-600">{personalErrors.lastName}</p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Email *
                  </label>
                  <input
                    type="email"
                    value={personal.email}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, email: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Enter your email address"
                  />
                  {personalErrors.email && (
                    <p className="mt-1 text-xs text-red-600">{personalErrors.email}</p>
                  )}
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Phone Number *
                  </label>
                  <input
                    type="tel"
                    value={personal.phone}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, phone: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Enter your phone number"
                  />
                  {personalErrors.phone && (
                    <p className="mt-1 text-xs text-red-600">{personalErrors.phone}</p>
                  )}
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={personal.bookingForSomeoneElse}
                  onChange={(e) =>
                    setPersonal((prev) => ({
                      ...prev,
                      bookingForSomeoneElse: e.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                Booking on behalf of someone else
              </label>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Flight/Train Information
                  </label>
                  <input
                    type="text"
                    value={personal.flightInfo}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, flightInfo: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Flight or train details"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">
                    Arrival From
                  </label>
                  <input
                    type="text"
                    value={personal.arrivalFrom}
                    onChange={(e) =>
                      setPersonal((prev) => ({ ...prev, arrivalFrom: e.target.value }))
                    }
                    className="w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                    placeholder="Where are you arriving from?"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Additional Note
                </label>
                <textarea
                  value={personal.additionalNote}
                  onChange={(e) =>
                    setPersonal((prev) => ({
                      ...prev,
                      additionalNote: e.target.value,
                    }))
                  }
                  className="h-24 w-full rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:border-navy focus:outline-none"
                  placeholder="Any special requirements or notes"
                />
              </div>
            </div>
          </section>
        </div>

        {saveError && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {saveError}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStep("review")}
            className="rounded-md border border-gray-300 bg-white px-6 py-2.5 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleConfirmBooking}
            disabled={saving}
            className="rounded-md bg-navy px-6 py-2.5 text-sm font-semibold uppercase tracking-wide text-white transition hover:bg-navy-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving…" : "Next"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <form
        onSubmit={goToReview}
        className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
      >
        <div className="flex">
          <div className="rounded-tl-lg bg-navy px-6 py-3 text-sm font-semibold text-white">
            Get Quick Quote
          </div>
        </div>

        <div className="border-t border-gray-100 p-5 sm:p-6">
          <div className="mb-5 flex items-center gap-2 text-navy">
            <RouteIcon className="h-5 w-5" />
            <h2 className="text-base font-semibold">Outbound Journey</h2>
          </div>

          <div className="space-y-3">
            <FieldRow icon={<LocationPinIcon />}>
              <LocationAutocomplete
                id="pickup-location"
                value={pickup}
                onChange={setPickup}
                placeholder="Enter Pickup Airport, Location or Postcode"
              />
            </FieldRow>

            {stops.map((stop, index) => (
              <StopRow
                key={index}
                idPrefix="stop-location"
                index={index}
                value={stop}
                onChange={(value) => {
                  const next = [...stops];
                  next[index] = value;
                  setStops(next);
                }}
                onRemove={() => removeStop(index)}
              />
            ))}

            <FieldRow icon={<FlagIcon />}>
              <LocationAutocomplete
                id="dropoff-location"
                value={dropoff}
                onChange={setDropoff}
                placeholder="Enter Dropoff Airport, Location or Postcode"
              />
            </FieldRow>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldRow icon={<CalendarIcon />}>
                <input
                  type="date"
                  value={date}
                  min={defaults.date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                />
              </FieldRow>

              <FieldRow icon={<ClockIcon />}>
                <div className="flex items-center gap-1 px-3">
                  <select
                    value={hour}
                    onChange={(e) => setHour(e.target.value)}
                    className="rounded border-0 bg-transparent py-3 text-sm text-gray-800 focus:outline-none focus:ring-0"
                    aria-label="Hour"
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <span className="text-gray-500">:</span>
                  <select
                    value={minute}
                    onChange={(e) => setMinute(e.target.value)}
                    className="rounded border-0 bg-transparent py-3 text-sm text-gray-800 focus:outline-none focus:ring-0"
                    aria-label="Minute"
                  >
                    {MINUTES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </FieldRow>
            </div>

            {touched && !timeValidation.valid && timeValidation.message && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {timeValidation.message}
              </div>
            )}
            {!touched && (
              <p className="text-xs text-gray-500">
                Bookings must be made at least {MIN_BOOKING_HOURS} hours before pickup.
              </p>
            )}

            <div className="pt-2">
              <p className="mb-3 text-sm font-semibold text-navy">Select Vehicle</p>
              <div className="grid grid-cols-1 gap-3">
                {VEHICLE_OPTIONS.map((option) => {
                  const isSelected = vehicle === option.id;
                  const isCompatible = isVehicleIdCompatible(
                    option.id,
                    effectivePassengers,
                    effectiveLuggage
                  );
                  const limits = VEHICLE_BOOKING_LIMITS[option.id];
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={!isCompatible}
                      onClick={() => handleVehicleChange(option.id)}
                      className={`relative rounded-lg border-2 p-4 text-left transition ${
                        !isCompatible
                          ? "cursor-not-allowed border-gray-200 bg-gray-50"
                          : isSelected
                            ? "border-accent bg-accent-light"
                            : "border-gray-200 bg-white hover:border-gray-300"
                      }`}
                    >
                      <div
                        className={`flex items-start gap-4 ${
                          !isCompatible ? "opacity-45 blur-[1px]" : ""
                        }`}
                      >
                        <div
                          className={`mt-0.5 shrink-0 ${
                            isSelected ? "text-navy" : "text-gray-400"
                          }`}
                        >
                          {option.id === "minibus" ? <VanIcon /> : <CarIcon />}
                        </div>
                        <div>
                          <p className={`font-semibold ${isSelected ? "text-navy" : "text-gray-600"}`}>
                            {option.name}
                          </p>
                          <p className="mt-1 text-xs text-gray-500 sm:text-sm">
                            {option.description}
                          </p>
                          <p className="mt-1 text-xs font-medium text-gray-400">
                            Capacity: {limits.maxPassengers} passengers · {limits.maxLuggage} luggage
                          </p>
                        </div>
                      </div>

                      {!isCompatible && (
                        <span className="absolute right-3 top-3 rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
                          Not available for {effectivePassengers}P/{effectiveLuggage}L
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FieldRow icon={<UsersIcon />}>
                <select
                  value={passengers}
                  onChange={(e) =>
                    setPassengers(Math.max(1, Math.min(MAX_PASSENGERS, Number(e.target.value))))
                  }
                  className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                  aria-label="Passengers"
                >
                  {passengerOptions.map((n) => (
                    <option key={n} value={n}>
                      {n} Passenger{n !== 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </FieldRow>

              <FieldRow icon={<LuggageIcon />}>
                <select
                  value={luggage}
                  onChange={(e) =>
                    setLuggage(Math.max(0, Math.min(MAX_LUGGAGE, Number(e.target.value))))
                  }
                  className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                  aria-label="Luggage"
                >
                  {luggageOptions.map((n) => (
                    <option key={n} value={n}>
                      {n} Luggage
                    </option>
                  ))}
                </select>
              </FieldRow>
            </div>

            {showReturn && (
              <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50/70 p-4">
                <div className="flex items-center gap-2 text-navy">
                  <RouteIcon className="h-5 w-5" />
                  <h3 className="text-base font-semibold">Return Journey</h3>
                </div>

                <FieldRow icon={<LocationPinIcon />}>
                  <LocationAutocomplete
                    id="return-pickup-location"
                    value={returnPickup}
                    onChange={setReturnPickup}
                    placeholder="Enter Return Pickup Airport, Location or Postcode"
                  />
                </FieldRow>

                {returnStops.map((stop, index) => (
                  <StopRow
                    key={index}
                    idPrefix="return-stop-location"
                    index={index}
                    value={stop}
                    onChange={(value) => {
                      const next = [...returnStops];
                      next[index] = value;
                      setReturnStops(next);
                    }}
                    onRemove={() => removeReturnStop(index)}
                  />
                ))}

                <FieldRow icon={<FlagIcon />}>
                  <LocationAutocomplete
                    id="return-dropoff-location"
                    value={returnDropoff}
                    onChange={setReturnDropoff}
                    placeholder="Enter Return Dropoff Airport, Location or Postcode"
                  />
                </FieldRow>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FieldRow icon={<CalendarIcon />}>
                    <input
                      type="date"
                      value={returnDate}
                      min={defaults.date}
                      onChange={(e) => setReturnDate(e.target.value)}
                      className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                    />
                  </FieldRow>

                  <FieldRow icon={<ClockIcon />}>
                    <div className="flex items-center gap-1 px-3">
                      <select
                        value={returnHour}
                        onChange={(e) => setReturnHour(e.target.value)}
                        className="rounded border-0 bg-transparent py-3 text-sm text-gray-800 focus:outline-none focus:ring-0"
                        aria-label="Return hour"
                      >
                        {HOURS.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                      <span className="text-gray-500">:</span>
                      <select
                        value={returnMinute}
                        onChange={(e) => setReturnMinute(e.target.value)}
                        className="rounded border-0 bg-transparent py-3 text-sm text-gray-800 focus:outline-none focus:ring-0"
                        aria-label="Return minute"
                      >
                        {MINUTES.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </FieldRow>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <FieldRow icon={<UsersIcon />}>
                    <select
                      value={returnPassengers}
                      onChange={(e) =>
                        setReturnPassengers(
                          Math.max(1, Math.min(MAX_PASSENGERS, Number(e.target.value)))
                        )
                      }
                      className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                      aria-label="Return passengers"
                    >
                      {passengerOptions.map((n) => (
                        <option key={n} value={n}>
                          {n} Passenger{n !== 1 ? "s" : ""}
                        </option>
                      ))}
                    </select>
                  </FieldRow>

                  <FieldRow icon={<LuggageIcon />}>
                    <select
                      value={returnLuggage}
                      onChange={(e) =>
                        setReturnLuggage(
                          Math.max(0, Math.min(MAX_LUGGAGE, Number(e.target.value)))
                        )
                      }
                      className="w-full px-4 py-3 text-sm text-gray-800 focus:outline-none"
                      aria-label="Return luggage"
                    >
                      {luggageOptions.map((n) => (
                        <option key={n} value={n}>
                          {n} Luggage
                        </option>
                      ))}
                    </select>
                  </FieldRow>
                </div>

                {returnError && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    {returnError}
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      if (returnStops.length >= MAX_STOPS) {
                        setSaveError(`You can only add up to ${MAX_STOPS} stops.`);
                        return;
                      }
                      setSaveError(null);
                      setReturnStops([...returnStops, ""]);
                    }}
                    disabled={returnStops.length >= MAX_STOPS}
                    className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <PlusIcon />
                    {returnStops.length >= MAX_STOPS ? `Max ${MAX_STOPS} stops` : "Add Stop"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReturn(false)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
                  >
                    <CloseIcon />
                    Remove Return Journey
                  </button>
                </div>
              </div>
            )}

            {quoteLoading && (
              <div className="rounded-md border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-700">
                Calculating distance and fare...
              </div>
            )}

            {quote && (
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <p className="font-semibold">
                  Estimated Fare: £{quote.estimated_fare.toFixed(2)}
                  {quote.return_leg ? " (return trip)" : ""}
                </p>
                <p className="mt-1 text-xs text-emerald-700">
                  Total {quote.distance_miles.toFixed(2)} miles · {quote.duration_minutes} mins
                  {quote.distance_source === "haversine_estimate"
                    ? " · Approximate route distance"
                    : ""}
                </p>
                {quote.return_leg && quote.outbound && (
                  <p className="mt-1 text-xs text-emerald-700">
                    Outbound £{quote.outbound.fare.toFixed(2)} ({quote.outbound.distance_miles.toFixed(2)} mi)
                    {" + "}
                    Return £{quote.return_leg.fare.toFixed(2)} ({quote.return_leg.distance_miles.toFixed(2)} mi)
                  </p>
                )}
              </div>
            )}

            {quoteError && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {quoteError}
              </div>
            )}

            {locationError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {locationError}
              </div>
            )}

            {saveError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {saveError}
              </div>
            )}

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  if (stops.length >= MAX_STOPS) {
                    setSaveError(`You can only add up to ${MAX_STOPS} stops.`);
                    return;
                  }
                  setSaveError(null);
                  setStops([...stops, ""]);
                }}
                disabled={stops.length >= MAX_STOPS}
                className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlusIcon />
                {stops.length >= MAX_STOPS
                  ? `Max ${MAX_STOPS} stops`
                  : "Add Stop"}
              </button>
              {!showReturn && (
                <button
                  type="button"
                  onClick={toggleReturnJourney}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 transition hover:bg-gray-50"
                >
                  <PlusIcon />
                  Add Return Journey
                </button>
              )}
            </div>
          </div>

          <button
            type="submit"
            className="mt-6 w-full rounded-md bg-navy py-4 text-sm font-bold uppercase tracking-wider text-white transition hover:bg-navy-dark disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!canProceedFromBooking || saving}
          >
            {quoteLoading ? "Calculating…" : "Review Booking"}
          </button>
        </div>
      </form>
    </div>
  );
}

import { MIN_BOOKING_HOURS } from "@/types/booking";

export function getMinimumPickupDateTime(): Date {
  const minimum = new Date();
  minimum.setHours(minimum.getHours() + MIN_BOOKING_HOURS);
  minimum.setMinutes(0, 0, 0);
  minimum.setHours(minimum.getHours() + 1);
  return minimum;
}

export function formatDateForInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getDefaultPickupValues(): {
  date: string;
  hour: string;
  minute: string;
} {
  const minimum = getMinimumPickupDateTime();
  return {
    date: formatDateForInput(minimum),
    hour: String(minimum.getHours()).padStart(2, "0"),
    minute: String(minimum.getMinutes()).padStart(2, "0"),
  };
}

export function validatePickupDateTime(
  date: string,
  hour: string,
  minute: string
): { valid: boolean; message?: string; hoursUntilPickup?: number } {
  if (!date || !hour || !minute) {
    return { valid: false, message: "Please select a pickup date and time." };
  }

  const pickup = new Date(`${date}T${hour}:${minute}:00`);
  if (Number.isNaN(pickup.getTime())) {
    return { valid: false, message: "Please enter a valid pickup date and time." };
  }

  const now = new Date();
  const diffMs = pickup.getTime() - now.getTime();
  const hoursUntilPickup = diffMs / (1000 * 60 * 60);

  if (hoursUntilPickup < MIN_BOOKING_HOURS) {
    const hoursShort = Math.max(0, Math.floor(hoursUntilPickup * 10) / 10);
    return {
      valid: false,
      message: `Bookings must be made at least ${MIN_BOOKING_HOURS} hours before pickup. Your selected time is only ${hoursShort} hours away.`,
      hoursUntilPickup,
    };
  }

  return { valid: true, hoursUntilPickup };
}

export function formatPickupDisplay(
  date: string,
  hour: string,
  minute: string
): string {
  const pickup = new Date(`${date}T${hour}:${minute}:00`);
  return pickup.toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function toPickupISODateTime(
  date: string,
  hour: string,
  minute: string
): string | null {
  const pickup = new Date(`${date}T${hour}:${minute}:00`);
  if (Number.isNaN(pickup.getTime())) return null;
  return pickup.toISOString();
}

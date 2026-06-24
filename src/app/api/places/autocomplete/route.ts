import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NormalizedSuggestion {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
}

interface NewPrediction {
  placeId?: string;
  text?: { text?: string };
  structuredFormat?: {
    mainText?: { text?: string };
    secondaryText?: { text?: string };
  };
}

interface NewResponse {
  suggestions?: { placePrediction?: NewPrediction }[];
  error?: { message?: string };
}

interface LegacyPrediction {
  description?: string;
  place_id?: string;
  structured_formatting?: {
    main_text?: string;
    secondary_text?: string;
  };
}

interface LegacyResponse {
  predictions?: LegacyPrediction[];
  status?: string;
  error_message?: string;
}

async function tryPlacesNew(
  input: string,
  apiKey: string,
  sessionToken?: string
): Promise<
  | { ok: true; suggestions: NormalizedSuggestion[] }
  | { ok: false; status: number; message: string }
> {
  const res = await fetch(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({
        input,
        includedRegionCodes: ["gb"],
        languageCode: "en-GB",
        regionCode: "GB",
        ...(sessionToken ? { sessionToken } : {}),
      }),
    }
  );

  const data = (await res.json()) as NewResponse;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: data.error?.message || "Places API (New) request failed.",
    };
  }

  const suggestions = (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NewPrediction => Boolean(p))
    .map((p) => ({
      placeId: p.placeId ?? "",
      description: p.text?.text ?? "",
      mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
      secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
    }))
    .filter((s) => s.description);

  return { ok: true, suggestions };
}

async function tryPlacesLegacy(
  input: string,
  apiKey: string,
  sessionToken?: string
): Promise<
  | { ok: true; suggestions: NormalizedSuggestion[] }
  | { ok: false; status: number; message: string }
> {
  const params = new URLSearchParams({
    input,
    components: "country:gb",
    language: "en-GB",
    key: apiKey,
  });
  if (sessionToken) params.set("sessiontoken", sessionToken);

  const res = await fetch(
    `https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`
  );
  const data = (await res.json()) as LegacyResponse;

  if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    return {
      ok: false,
      status: 403,
      message:
        data.error_message || `Legacy Places API error: ${data.status}.`,
    };
  }

  const suggestions = (data.predictions ?? [])
    .map((p) => ({
      placeId: p.place_id ?? "",
      description: p.description ?? "",
      mainText: p.structured_formatting?.main_text ?? p.description ?? "",
      secondaryText: p.structured_formatting?.secondary_text ?? "",
    }))
    .filter((s) => s.description);

  return { ok: true, suggestions };
}

export async function GET(req: NextRequest) {
  const input = req.nextUrl.searchParams.get("input")?.trim() ?? "";
  const sessionToken =
    req.nextUrl.searchParams.get("sessionToken") || undefined;

  if (input.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const apiKey =
    process.env.GOOGLE_PLACES_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing the Google Places API key." },
      { status: 500 }
    );
  }

  try {
    // Prefer Places API (New); fall back to the legacy Places API if the new
    // endpoint is blocked/not enabled on the project or key.
    const primary = await tryPlacesNew(input, apiKey, sessionToken);
    if (primary.ok) {
      return NextResponse.json({ suggestions: primary.suggestions });
    }

    const fallback = await tryPlacesLegacy(input, apiKey, sessionToken);
    if (fallback.ok) {
      return NextResponse.json({ suggestions: fallback.suggestions });
    }

    return NextResponse.json(
      {
        error:
          "Address search is blocked. Enable 'Places API (New)' (or 'Places API') for this key in Google Cloud. " +
          `Details: ${primary.message}`,
      },
      { status: 502 }
    );
  } catch {
    return NextResponse.json(
      { error: "Could not reach Google Places. Check your connection." },
      { status: 502 }
    );
  }
}

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;
const tableColumnCache = new Map<string, Set<string>>();

function getSupabaseCredentials(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase credentials are missing. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  return { url, serviceRoleKey };
}

/**
 * Server-only Supabase client using the service role key.
 * Never import this into client components.
 */
export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const { url, serviceRoleKey } = getSupabaseCredentials();

  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cachedClient;
}

export const BOOKINGS_TABLE = "later_bookings";

export async function getSupabaseTableColumns(tableName: string): Promise<Set<string>> {
  if (tableColumnCache.has(tableName)) {
    return tableColumnCache.get(tableName)!;
  }

  const { url, serviceRoleKey } = getSupabaseCredentials();
  const response = await fetch(`${url}/rest/v1/`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Failed to introspect Supabase table "${tableName}".`);
  }

  const schema = (await response.json()) as {
    definitions?: Record<string, { properties?: Record<string, unknown> }>;
  };

  const properties = schema.definitions?.[tableName]?.properties ?? {};
  const columns = new Set(Object.keys(properties));
  tableColumnCache.set(tableName, columns);
  return columns;
}

/**
 * Returns the requested `columns` filtered to only those that actually exist
 * on `tableName`, as a comma-joined PostgREST select string.
 *
 * Use this for background notifiers whose select lists must stay valid even if
 * the table schema drifts (e.g. `pickup_date`/`pickup_time` are added/removed
 * by a migration). Columns that don't exist are silently dropped so the query
 * never 500s on a missing column; callers' resolvers already fall back to
 * other columns when an optional one is absent.
 *
 * Introspection is cached per process via `getSupabaseTableColumns`.
 */
export async function selectColumnsFor(
  tableName: string,
  columns: string[]
): Promise<string> {
  let existing: Set<string>;
  try {
    existing = await getSupabaseTableColumns(tableName);
  } catch {
    // Introspection failed (Supabase REST unreachable / not configured). Fall
    // back to returning all requested columns so a transient introspect error
    // doesn't silently change email behaviour — a real missing column will
    // still surface as a query error, which the route reports as HTTP 500.
    return columns.join(", ");
  }
  return columns.filter((c) => existing.has(c)).join(", ");
}

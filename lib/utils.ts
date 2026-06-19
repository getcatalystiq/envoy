import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// RFC-4122 layout, case-insensitive. Matches what Postgres' `uuid` type accepts
// (PG is lenient on the version/variant nibbles), so guarding with this prevents
// the `22P02 invalid input syntax for type uuid` 500 a malformed path param
// would otherwise throw deep in a query.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` is a syntactically valid UUID. Use to reject malformed id
 * path params before they reach a `::uuid` query (else Postgres 500s). */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Safe JSON response helper — avoids Turbopack production build issues
 * with Response.json() and NextResponse.json().
 */
export function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Read and JSON-parse a request body with a hard size cap. Returns the parsed
 * value, or an error Response (413 too large / 400 malformed) for the caller to
 * return. Used by unauthenticated/webhook endpoints to bound DoS surface and
 * fail cleanly on bad input instead of throwing a 500.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<{ data: unknown } | { error: Response }> {
  const text = await request.text();
  if (text.length > maxBytes) {
    return { error: jsonResponse({ error: "Request body too large" }, 413) };
  }
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: jsonResponse({ error: "Invalid JSON body" }, 400) };
  }
}

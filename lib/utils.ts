import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

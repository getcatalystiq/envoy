import "server-only";

// Shared runtime guards (internal — not part of the public SDK surface).
//
// Several modules independently re-derived the same "this argument must be a non-empty string"
// runtime check: the broadcast program definition (program.ts), the cursor key reader (cursor.ts),
// and the topic key builder (topics.ts). Each threw its OWN error type — a `BroadcastProgramError`,
// a generic `Error`, a `TemplateFetchError`-adjacent `Error` — so a blind dedup that hard-coded one
// error class would silently change which error type callers (and tests) observe. `assertNonEmpty`
// keeps the single guard implementation but takes an optional `errorFactory` so each call site
// preserves its module-specific thrown error type.

/**
 * Assert that `value` is a non-empty string (after trimming surrounding whitespace), narrowing it to
 * `string` for the caller. A non-string, the empty string, or a whitespace-only string fails.
 *
 * @param name human-readable argument name, interpolated into the default message.
 * @param value the value to guard.
 * @param errorFactory optional factory producing the error to throw — lets each module preserve its
 *   own thrown error TYPE (e.g. `BroadcastProgramError`) instead of a generic `Error`. When omitted,
 *   a generic `Error` with the standard `[@catalystiq/envoy-sdk] <name> must be a non-empty string.` message is
 *   thrown.
 */
export function assertNonEmpty(
  name: string,
  value: unknown,
  errorFactory?: (message: string) => Error
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    const message = `[@catalystiq/envoy-sdk] ${name} must be a non-empty string.`;
    throw errorFactory ? errorFactory(message) : new Error(message);
  }
}

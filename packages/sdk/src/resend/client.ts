import "server-only";

import { Resend } from "resend";

// Lazy Resend client (U3 / origin R43, and the no-op-when-unset pattern from the app's
// `lib/ses.ts` getClient singleton — reimplemented, not imported, per R48).
//
// Two app patterns are reproduced here:
//   1. Lazy singleton: the underlying `Resend` is constructed at most once, on first use,
//      not at `createEnvoy` time. This mirrors `lib/ses.ts`'s `getClient()` memoization.
//   2. No-op when the key is unset: `lib/ses.ts` assumes SES creds always exist; the SDK is a
//      drop-in where a dev may run without a Resend key in dev/CI. The app's mailer treats a
//      missing transport as a silent no-op, and the unit spec (R43 / "unset RESEND_API_KEY ⇒
//      Resend calls no-op without throwing") requires the same here.
//
// IMPORTANT runtime fact (verified against resend@6.14.0): `new Resend(undefined)` THROWS
// "Missing API key" in its constructor. So the no-op path must NOT construct a `Resend` at all —
// it reports `enabled === false` and returns `null` from `client()`, and callers skip the call.
// Constructing-then-swallowing is not an option; the constructor itself is the failure point.

/**
 * A lazily-constructed Resend client bound to one API key. Constructed at most once on first
 * `client()` call. When the key is empty/undefined the handle is permanently disabled: `enabled`
 * is `false` and `client()` returns `null` so callers no-op rather than throw.
 */
export interface ResendClientHandle {
  /** True when an API key was supplied — i.e. Resend calls will actually be attempted. */
  readonly enabled: boolean;
  /**
   * The underlying Resend client, constructed lazily on first call. Returns `null` when disabled
   * (no key) so callers can `if (!c) return;` to no-op. Never throws for a missing key — that
   * decision is surfaced as `enabled === false`, not an exception.
   */
  client(): Resend | null;
}

/**
 * Build a lazy Resend handle. `apiKey` is read once here and never logged or stored anywhere it
 * could be serialized (it lives only inside the closure / the constructed client). Pass the raw
 * `resendApiKey` from `createEnvoy` config (which itself comes from an env secret per R43).
 */
export function createResendClientHandle(apiKey: string | undefined): ResendClientHandle {
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  const enabled = trimmed.length > 0;

  let instance: Resend | null = null;

  return {
    enabled,
    client(): Resend | null {
      if (!enabled) return null;
      if (instance === null) {
        // Constructed exactly once. `trimmed` is guaranteed non-empty here, so the constructor
        // does not hit its "Missing API key" throw.
        instance = new Resend(trimmed);
      }
      return instance;
    },
  };
}

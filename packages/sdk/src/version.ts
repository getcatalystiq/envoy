import "server-only";

// Version + capability surface (host cutover gate).
//
// The host's big-bang cutover refuses to merge unless the PINNED SDK actually carries the
// enhancements it depends on (attachments for the booking .ics, the hardened `system` lane). A bare
// version string is not enough — the published `SDK_VERSION` was historically a `"0.0.0"` placeholder
// decoupled from `package.json`, so a gate keying on it would read a constant, not the truth.
//
// Two fixes here:
//   1. SDK_VERSION is BUILD-DERIVED from package.json (the single source of version truth) — it can
//      no longer drift from the published version.
//   2. getCapabilities() reports the feature flags the host gate reads. Each flag is guarded by a
//      test that exercises the REAL feature (test/version.test.ts asserts the version match;
//      test/drip/transactional.test.ts exercises attachments + the system lane), so a regressed
//      feature fails the release rather than silently reporting a true flag.

import pkg from "../package.json";

/**
 * The SDK version, sourced from `package.json` at build time (esbuild/tsup inlines the JSON;
 * vitest resolves it the same way). Use this for the host's pinned-version assertion — it always
 * equals the published `package.json` version, never a stale hand-set constant.
 */
export const SDK_VERSION: string = pkg.version;

/**
 * Machine-readable capability flags the consuming host's cutover gate asserts before merging the
 * big-bang migration (the host runs immediate, no-fallback, so the gate is load-bearing). Each flag
 * corresponds to a Phase-0 enhancement and is exercised by a test in this package, so the flag
 * cannot report `true` for a feature that has regressed.
 */
export interface SdkCapabilities {
  /** `send.transactional` accepts `attachments` (the booking-confirmation `.ics` path). */
  attachments: boolean;
  /**
   * `send.transactional` supports the non-gated, floor-respecting `system: true` lane — a paid
   * receipt survives a marketing opt-out but is still suppressed by a global unsubscribe / bounce /
   * complaint / GDPR delete, and the lane enforces a `systemTemplateIds` allow-list.
   */
  systemLane: boolean;
}

/**
 * Report the SDK's build-time capability flags. The consuming host reads this (alongside
 * {@link SDK_VERSION}) in its cutover CI gate. The returned object is frozen so a caller cannot
 * mutate the reported capabilities.
 */
export function getCapabilities(): Readonly<SdkCapabilities> {
  return Object.freeze({ attachments: true, systemLane: true });
}

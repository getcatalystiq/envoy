"use client";

// @envoy/sdk/client — React hooks entry (read-only state for host-built admin screens).
//
// Hooks are populated in U17: useProgramState, useConsent, useBroadcastHistory, useAnalytics.
// This entry carries the "use client" directive (re-injected by tsup's banner, since esbuild
// strips it) and imports no server-only code.

export const SDK_CLIENT_VERSION = "0.0.0";

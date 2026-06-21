// @envoy/sdk — server entry.
//
// Headless Resend drip + broadcast email SDK for Next.js: bring-your-own-Postgres,
// host-owns-auth, single-tenant. This package is self-contained and shares no runtime
// code with the host app — see docs/brainstorms/2026-06-21-envoy-resend-sdk-rearchitecture-requirements.md
//
// Surface is populated by later units:
//   U3  createEnvoy(config)        — the root handle
//   U4  createEnvoyHandler({...})  — the mounted route handler
//   U7  enroll / contacts          — event-driven enrollment + sync
//   U8  defineSequence             — the AI drip lane
//   U10 send.transactional         — one-shot templated send
//   U15 defineBroadcastProgram     — the broadcast program

export const SDK_VERSION = "0.0.0";

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

// U2 — DB layer (injected-pool wrapper, namespaced helpers, host-applied migrations).
export {
  createDb,
  NamespacedDb,
  normalizeEmail,
  type SdkPool,
  type SdkQueryResult,
} from "./db/pool.js";
export {
  migrate,
  type MigrateOptions,
  type MigrateResult,
} from "./db/migrate.js";

// U3 — createEnvoy: config validation, secrets, namespace fingerprint, lazy Resend client.
export {
  createEnvoy,
  resolveConfig,
  computeNamespaceFingerprint,
  redactEmail,
  redactValue,
  EnvoyConfigError,
  EnvoyNamespaceError,
  type Envoy,
  type EnvoyConfig,
  type EnvoyAgentConfig,
  type EnvoyStreamConfig,
  type ResolvedEnvoyConfig,
} from "./config.js";
export {
  createResendClientHandle,
  type ResendClientHandle,
} from "./resend/client.js";

// U4 — route-handler factory with per-sub-path auth (the single mounted catch-all).
export {
  createEnvoyHandler,
  createDripCronHandler,
  resolveSubpath,
  type EnvoyHandlerConfig,
  type EnvoyRouteHandlers,
  type SubHandler,
  type Authorize,
  type AuthorizeResult,
  type DripCronHandlerConfig,
} from "./route/handler.js";

// U6 — consent mirror (the send gate) + signed topic-scoped unsubscribe landing.
export {
  ConsentMirror,
  createConsentMirror,
  STREAMS,
  CONSENT_RANK,
  type Stream,
  type ConsentStatus,
  type ConsentRow,
  type ConsentSetInput,
  type ConsentSetResult,
} from "./consent/mirror.js";
export {
  buildListUnsubscribeHeaders,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  handleUnsubscribe,
  checkRateLimit,
  clientIp,
  MIN_UNSUBSCRIBE_TTL_SECONDS,
  DEFAULT_UNSUB_RATE_LIMIT,
  DEFAULT_UNSUB_RATE_WINDOW_SECONDS,
  type UnsubscribeClaims,
  type VerifyResult,
  type CreateTokenInput,
  type ListUnsubscribeHeaders,
  type RateLimitResult,
  type UnsubscribeLandingConfig,
} from "./consent/unsubscribe.js";

// U5 — Resend webhook receiver + contact-event ingest (Svix-verified upstream by U4).
export {
  createWebhookReceiver,
  ingestEvent,
  extractRecipientEmail,
  type ResendWebhookEvent,
  type WebhookIngestResult,
} from "./route/webhook.js";

// U7 — Topic provisioning (idempotent, cached per (stream, subject)).
export {
  provisionTopic,
  topicKeyFor,
  type ProvisionTopicInput,
  type ProvisionTopicResult,
} from "./resend/topics.js";

// U7 — Segment membership helpers (fail-soft Resend wrappers).
export {
  addToSegment,
  removeFromSegment,
  type SegmentOpResult,
} from "./resend/segments.js";

// U7 — Contacts lifecycle: event-driven enroll, push-on-write SegmentSync, GDPR deletion.
export {
  enroll,
  deleteContact,
  createSegmentSync,
  SegmentSync,
  type ContactInput,
  type EnrollOptions,
  type EnrollResult,
  type SyncTopic,
  type SyncPushInput,
  type SyncPushResult,
  type DeleteContactResult,
} from "./contacts.js";

// U10 — Transactional send: one-shot, non-AI templated `emails.send` (mirror-gated, required
// stream, RFC 8058 List-Unsubscribe, idempotency-as-request-option).
export {
  sendTransactional,
  TransactionalSendError,
  type TransactionalSendInput,
  type TransactionalSendResult,
  type TransactionalSendConfig,
  type TransactionalSkipReason,
  type TransactionalVariables,
} from "./drip/transactional.js";

// U8 — Drip engine: sequences, JIT AI personalization (Claude Managed Agents), fail-safe send.
export {
  defineSequence,
  SequenceDefinitionError,
  type Sequence,
  type SequenceStep,
  type DefineSequenceInput,
} from "./drip/sequence.js";
export {
  runDripStep,
  tickDrip,
  type DueStep,
  type DripStepResult,
  type DripSkipReason,
  type DripEngineConfig,
  type SequenceRegistry,
  type DripTickConfig,
  type DripTickResult,
  type DripTickItem,
} from "./drip/engine.js";
export {
  runAgentSession,
  harvestAgentSession,
  generateOrHarvestSlots,
  sanitizeContactForAgent,
  buildSlotGoal,
  extractSlots,
  getAgentClient,
  setAgentClient,
  AgentError,
  type AgentCallOpts,
  type AgentSessionResult,
  type HarvestResult,
  type GeneratedSlots,
  type GenerateSlotsInput,
  type GenerateOrHarvestInput,
  type SlotGenerationResult,
} from "./agent/session.js";

// U11 — Broadcast send-once claim + crash-safe resume (external claim row; no Resend
// idempotency key exists for broadcasts, so the claim + broadcasts.list precheck is the dedup).
export {
  claim,
  persistBroadcastId,
  markSent,
  resolveResumeBroadcastId,
  DEFAULT_PRECHECK_MAX_PAGES,
  DEFAULT_PRECHECK_PAGE_SIZE,
  DEFAULT_PRECHECK_RETRIES,
  DEFAULT_PRECHECK_RETRY_DELAY_MS,
  type BroadcastClaimRow,
  type ClaimResult,
  type ResumePrecheckOptions,
  type ResumeResolution,
} from "./broadcast/claim.js";

export {
  read as readCursor,
  due as cursorDue,
  advance as advanceCursor,
  tryAdvance as tryAdvanceCursor,
  setPaused as setCursorPaused,
  type CursorKey,
  type CursorState,
  type DueOptions,
  type AdvanceOptions,
  type AdvanceResult,
} from "./broadcast/cursor.js";

// U12 — broadcast render + send (Resend Template → html/text → broadcasts.create).
export {
  getTemplate,
  clearTemplateCache,
  TemplateFetchError,
  type FetchedTemplate,
  type TemplateVariableSpec,
} from "./resend/templates.js";
export {
  renderBroadcast,
  sendBroadcast,
  BroadcastRenderError,
  type BroadcastVariables,
  type RenderBroadcastInput,
  type RenderedBroadcast,
  type SendBroadcastInput,
  type SendBroadcastResult,
} from "./broadcast/render.js";

// U14 — Reconcile sweep: topics diff + base-Segment repair + cost control (dirty-set narrowing,
// resumable full-sweep, 429 backoff, fail-loud on an unmapped topic id).
export {
  reconcile,
  reconcileContact,
  type ReconcileOptions,
  type ReconcileSweepResult,
  type ReconcileContactInput,
  type ReconcileContactResult,
  type ReconcileOutcome,
} from "./broadcast/reconcile.js";

// U16 — MCP endpoint (authed): a mounted MCP server re-pointed at the SDK internals so an agent can
// operate the lifecycle (enroll, inspect sequences/programs, read state/consent, trigger broadcast,
// erase). Independently authenticated (dedicated credential), never open (R25, R42).
export {
  createMcpRouteHandler,
  createEnvoyMcpHandler,
  registerEnvoyTools,
  defaultVerifyMcpToken,
  SERVER_INSTRUCTIONS as MCP_SERVER_INSTRUCTIONS,
  type McpRouteConfig,
  type McpVerifyToken,
  type McpSequenceRegistry,
  type McpProgramRegistry,
} from "./route/mcp.js";

// U15 — Declarative broadcast program + `runIssue` convenience: the canonical
// reconcile → claim/resume → render → send → advance ordering, per-subject fail-soft. The raw
// primitives (U11–U14) stay exported above; this is sugar over them, not a replacement.
export {
  defineBroadcastProgram,
  BroadcastProgramError,
  type BroadcastProgram,
  type DefineBroadcastProgramInput,
  type ProgramTopic,
  type ProgramRender,
  type RenderContext,
  type RenderedIssue,
  type RunIssueInput,
  type RunIssueResult,
  type IssueSkipReason,
} from "./broadcast/program.js";

// U18 — Config-time validation (fail loud, not at send time): synchronous stream + watermark-column
// checks (no network) and the lazy slot⇄Template network check (cached, fired on first use or an
// explicit `validateConfig`). A draft Template (`variables: null`) warns; a concrete missing slot errors.
export {
  validateConfig,
  validateSequences,
  validateSequenceSlots,
  assertTransactionalStream,
  assertWatermarkColumnType,
  clearValidationCache,
  ValidationError,
  type WatermarkColumnDeclaration,
  type StepSlotCheck,
  type SequenceValidationResult,
  type ValidateInput,
  type ValidateResult,
} from "./validate.js";

// The single mounted catch-all that hosts the whole SDK surface (U4 / KTD8).
//
// One route file owns every Envoy sub-path. The factory authenticates EACH sub-path
// with its OWN mechanism — host `authorize` for /api + /read, CRON_SECRET for /cron,
// Svix for /webhook, the signed token for /unsubscribe, the MCP credential for /mcp.
// Nothing reaches host logic without first clearing its gate.

import {
  createEnvoyHandler,
  createDripCronHandler,
  createWebhookReceiver,
  handleUnsubscribe,
} from "@envoy/sdk";

import {
  envoy,
  mirror,
  sequenceRegistry,
  digestProgram,
  UNSUBSCRIBE_BASE_URL,
} from "../../../../envoy";

// In a real host, `authorize` checks the host's own session/cookie. The example trusts a
// shared admin token so the dogfood run can drive /api from curl. cron/webhook/unsubscribe/mcp
// do NOT use this — they carry no host session.
async function authorize(request: Request): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${process.env.EXAMPLE_ADMIN_TOKEN ?? ""}`;
  return expected.length > "Bearer ".length && header === expected;
}

// The prebuilt drip tick — claims due enrollments, generates-or-harvests, sends, advances.
const dripTick = createDripCronHandler({
  envoy,
  registry: sequenceRegistry,
  tick: {
    mirror,
    unsubscribeBaseUrl: UNSUBSCRIBE_BASE_URL,
    stream: "digest",
    limit: 100,
  },
});

// The broadcast tick is wired by hand because the host owns the content query: the cron fetches
// "what's new since the watermark" and hands it to `runIssue`, which enforces the canonical
// reconcile → claim/resume → render → send → advance ordering with the send-once claim.
async function broadcastTick(): Promise<Response> {
  // In the example the "content query" is a stub; a real host would read its own table filtered
  // by the cursor watermark. An empty batch ⇒ render returns null ⇒ runIssue skips (no send).
  const items: Array<{ id: string; publishedAt: string; title: string }> = [];
  const result = await digestProgram.runIssue(envoy, { subjectKey: "default", items });
  return Response.json({ ok: true, program: digestProgram.key, result });
}

// Both crons share the one CRON_SECRET-gated `/cron` slot; dispatch on the trailing segment.
async function cron(request: Request): Promise<Response> {
  const tail = new URL(request.url).pathname.split("/").filter(Boolean).pop();
  if (tail === "broadcast") return broadcastTick();
  // Default (and `/cron/drip`) drives the drip lane.
  return dripTick(request);
}

const webhook = createWebhookReceiver(envoy);

const handlers = createEnvoyHandler({
  envoy,
  authorize,
  environment: process.env.ENVIRONMENT ?? "prod",
  mcpSecret: process.env.ENVOY_MCP_SECRET,
  // /cron/* — the factory has already enforced CRON_SECRET before this runs. Dispatches
  // /cron/drip → the drip tick and /cron/broadcast → the newsletter runIssue.
  cron,
  // /webhook/* — the factory has already Svix-verified the body before this runs.
  webhook,
  // /unsubscribe/* — self-authenticating signed token; the SDK writes a topic-scoped opt_out
  // through the consent mirror and returns the uniform RFC 8058 response.
  unsubscribe: (request) =>
    handleUnsubscribe(request, {
      secret: envoy.config.unsubscribeSecret,
      mirror,
      db: envoy.db,
    }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;

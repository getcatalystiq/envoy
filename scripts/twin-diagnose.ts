/**
 * Twin integration diagnostic — exercises the real run lifecycle and dumps the
 * actual event shapes so we can see whether the platform is calling Twin
 * correctly and where the final output text lives.
 *
 * Usage (does NOT need DATABASE_URL — only the Twin creds):
 *   TWIN_API_KEY=twin_xxx TWIN_AGENT_ID=019e... npx tsx scripts/twin-diagnose.ts
 *   # optional: TWIN_API_URL (default https://build.twin.so),
 *   #           TWIN_PROMPT ("Generate ... JSON subject/body" by default)
 *
 * It prints every step (auth, agent, start run, poll events) and the RAW event
 * JSON, then shows what lib/twin.ts's extractFinalOutput WOULD return vs. the
 * real output, so we can fix the extractor if it's looking in the wrong place.
 */

const API_URL = (process.env.TWIN_API_URL || "https://build.twin.so").replace(/\/$/, "");
const API_KEY = process.env.TWIN_API_KEY || "";
const AGENT_ID = process.env.TWIN_AGENT_ID || process.argv[2] || "";
const PROMPT =
  process.env.TWIN_PROMPT ||
  'Generate educational email content for this target.\n\n<target_data>\n{"first_name":"Pat","company":"Acme","email":"pat@acme.test"}\n</target_data>\n\nRespond with JSON containing "subject" and "body" fields. Optionally include a "confidence_score" between 0 and 1.';

function hr(label: string) {
  console.log(`\n${"=".repeat(8)} ${label} ${"=".repeat(8)}`);
}

async function twin(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// Replica of lib/twin.ts extractFinalOutput so we can see if it finds the output.
function extractFinalOutput(events: any[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i].event;
    if (!e || typeof e !== "object") continue;
    const message = e.message ?? e.assistant_message ?? e.output;
    if (message) {
      const text = message.text ?? message.content ?? message.body;
      if (typeof text === "string" && text.length > 0) return text;
    }
    const direct = e.text ?? e.content ?? e.output;
    if (typeof direct === "string" && direct.length > 0) return direct;
  }
  return "";
}

async function main() {
  if (!API_KEY || !AGENT_ID) {
    console.error("Set TWIN_API_KEY and TWIN_AGENT_ID (or pass agent id as arg 1).");
    process.exit(1);
  }
  console.log(`API_URL=${API_URL}\nAGENT_ID=${AGENT_ID}\nKEY=${API_KEY.slice(0, 12)}…`);

  hr("1. auth: GET /v1/me");
  const me = await twin("/v1/me");
  console.log("status:", me.status, "| body:", JSON.stringify(me.body)?.slice(0, 300));
  if (me.status !== 200) {
    console.error("Auth failed — key invalid or plan-gated. Stopping.");
    process.exit(1);
  }

  hr("2. agent: GET /v1/agents/{id}");
  const agent = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}`);
  console.log("status:", agent.status);
  console.log("agent:", JSON.stringify(agent.body?.agent ?? agent.body, null, 2)?.slice(0, 800));
  if (agent.status !== 200) {
    console.error("Agent not reachable. Stopping.");
    process.exit(1);
  }

  hr("3. start run: POST /v1/agents/{id}/runs");
  const started = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}/runs`, {
    method: "POST",
    body: JSON.stringify({ run_mode: "run", user_message: PROMPT }),
  });
  console.log("status:", started.status, "| body:", JSON.stringify(started.body, null, 2)?.slice(0, 600));
  const run = started.body?.run ?? started.body;
  const runId = run?.run_id;
  if (started.status >= 400 || !runId) {
    console.error("Could not start run. Stopping.");
    process.exit(1);
  }
  console.log("run_id:", runId, "| initial status:", run.status, "| is_finished:", run.is_finished);

  hr("4. poll events: GET /v1/agents/{id}/runs/{run_id}/events");
  const deadline = Date.now() + 5 * 60 * 1000;
  const all: any[] = [];
  let afterIndex: number | undefined;
  let finished = false;
  let poll = 0;
  while (Date.now() < deadline) {
    poll++;
    const qs = afterIndex !== undefined ? `?after_index=${afterIndex}&limit=200` : `?limit=200`;
    const ev = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}/runs/${encodeURIComponent(runId)}/events${qs}`);
    if (ev.status >= 400) {
      console.log(`poll ${poll}: events error ${ev.status}:`, JSON.stringify(ev.body)?.slice(0, 200));
      break;
    }
    const events = ev.body?.events ?? [];
    if (events.length) {
      all.push(...events);
      // Show BOTH possible index field names so we know which one is real.
      const last = events[events.length - 1];
      const idx = last.event_index ?? last.index;
      afterIndex = typeof idx === "number" ? idx : afterIndex;
      console.log(
        `poll ${poll}: +${events.length} events (total ${all.length}); last index field: ` +
          `event_index=${last.event_index} index=${last.index}; event keys=[${Object.keys(last.event || {})}]`,
      );
    } else {
      console.log(`poll ${poll}: no new events (total ${all.length})`);
    }
    // terminal check (key-based + status)
    const term = events.some((e: any) => {
      const k = Object.keys(e.event || {}).map((s) => s.toLowerCase());
      return ["completed", "finished", "failed", "errored", "cancelled", "canceled"].some((t) => k.includes(t));
    });
    // also reconcile via run status
    const r = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}/runs?filter_run_id=${encodeURIComponent(runId)}&page_size=1`);
    const cur = r.body?.runs?.[0];
    if (term || cur?.is_finished) {
      finished = true;
      console.log(`finished: terminal_event=${term} run.is_finished=${cur?.is_finished} status=${cur?.status} outcome=${cur?.outcome}`);
      break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  hr("5. RAW events (full JSON)");
  console.log(JSON.stringify(all, null, 2));

  hr("6. extraction analysis");
  console.log("finished:", finished, "| total events:", all.length);
  const extracted = extractFinalOutput(all);
  console.log("extractFinalOutput() returned:", extracted.length, "chars");
  console.log("---- extracted text ----\n" + (extracted || "(EMPTY — extractor did not find the output)"));
  console.log("\n---- last event.event keys (where output likely lives) ----");
  for (const e of all.slice(-5)) {
    console.log("event keys:", Object.keys(e.event || {}), "| sample:", JSON.stringify(e.event)?.slice(0, 400));
  }
}

main().catch((e) => {
  console.error("DIAGNOSTIC ERROR:", e);
  process.exit(1);
});

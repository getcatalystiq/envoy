/**
 * Twin integration diagnostic — drives a real run the way Envoy does and shows
 * the extracted output, so you can verify the platform invokes Twin correctly.
 *
 * Usage (needs only the Twin creds, not DATABASE_URL):
 *   TWIN_API_KEY=twin_xxx TWIN_AGENT_ID=019e... npx tsx scripts/twin-diagnose.ts
 *   # optional: TWIN_API_URL (default https://build.twin.so)
 *
 * By default it sends the block-personalization agent's STRUCTURED goal override
 * ({mode, original_content, prompt, target, block_type}) as `user_message`, polls
 * to the nested `Finished` event, decodes the `llm` tool result, and prints the
 * resulting {"body": ...}. Mirrors lib/twin.ts's runAgent/extractFinalOutput.
 */

const API_URL = (process.env.TWIN_API_URL || "https://build.twin.so").replace(/\/$/, "");
const API_KEY = process.env.TWIN_API_KEY || "";
const AGENT_ID = process.env.TWIN_AGENT_ID || process.argv[2] || "";

// Default: a personalization goal override (the agent reads user_message as JSON).
const GOAL = {
  mode: "personalize",
  original_content: "We help businesses move equipment across borders with ATA Carnets.",
  prompt: "Make it warmer and reference the recipient's company.",
  target: { first_name: "Pat", last_name: "Lee", company: "Acme Logistics", email: "pat@acme.test", role: "Operations Manager" },
  block_type: "Text",
};
const USER_MESSAGE = process.env.TWIN_PROMPT || JSON.stringify(GOAL);

const TERMINAL = new Set(["finished", "completed", "failed", "errored", "cancelled", "canceled"]);

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
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return { status: res.status, body };
}

// Descend events[i].event.event.event -> { <Type>: payload }
function unwrap(raw: any): { type: string; data: any } | null {
  let node = raw;
  for (let i = 0; i < 8 && node && typeof node === "object" && !Array.isArray(node) && "event" in node && typeof node.event === "object"; i++) {
    node = node.event;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const keys = Object.keys(node);
  if (!keys.length) return null;
  return { type: keys[0], data: node[keys[0]] };
}

// Decode Twin's Value tree (StructValue/StringValue/...) to plain JS.
function decode(v: any): any {
  if (v == null || typeof v !== "object") return v;
  if ("kind" in v) return decode(v.kind);
  if ("StringValue" in v) return v.StringValue;
  if ("BoolValue" in v) return v.BoolValue;
  if ("NumberValue" in v) return v.NumberValue;
  if ("NullValue" in v) return null;
  if ("StructValue" in v) return decode(v.StructValue);
  if ("ListValue" in v) return decode(v.ListValue);
  if ("fields" in v && v.fields && typeof v.fields === "object") {
    const o: any = {};
    for (const [k, val] of Object.entries(v.fields)) o[k] = decode(val);
    return o;
  }
  if ("values" in v && Array.isArray(v.values)) return v.values.map(decode);
  return v;
}

function extractFinalOutput(events: any[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const p = unwrap(events[i].event);
    if (!p || p.type !== "ToolCallResolved" || p.data?.tool_name !== "llm") continue;
    const decoded = decode(p.data.output);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      if (typeof decoded.body === "string" || typeof decoded.subject === "string") return JSON.stringify(decoded);
    }
    if (typeof decoded === "string" && decoded.trim()) return decoded;
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
  console.log("status:", me.status, JSON.stringify(me.body)?.slice(0, 200));
  if (me.status !== 200) { console.error("Auth failed."); process.exit(1); }

  hr("2. start run (structured goal as user_message)");
  console.log("user_message:", USER_MESSAGE.slice(0, 200));
  const started = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}/runs`, {
    method: "POST",
    body: JSON.stringify({ run_mode: "run", user_message: USER_MESSAGE }),
  });
  const runId = started.body?.run?.run_id;
  console.log("status:", started.status, "run_id:", runId);
  if (!runId) { console.error("Could not start run."); process.exit(1); }

  hr("3. poll events to the nested Finished event");
  const all: any[] = [];
  let afterIndex: number | undefined;
  let stable = 0;
  let finished = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const qs = afterIndex !== undefined ? `?after_index=${afterIndex}&limit=500` : `?limit=500`;
    const ev = await twin(`/v1/agents/${encodeURIComponent(AGENT_ID)}/runs/${encodeURIComponent(runId)}/events${qs}`);
    const events = ev.body?.events || [];
    if (events.length) {
      all.push(...events);
      afterIndex = events[events.length - 1].event_index;
      stable = 0;
      console.log(`+${events.length} (total ${all.length}): ${events.map((e: any) => unwrap(e.event)?.type).join(",")}`);
    } else {
      stable++;
    }
    if (all.some((e) => TERMINAL.has((unwrap(e.event)?.type || "").toLowerCase()))) { finished = true; console.log(">>> nested terminal event seen"); break; }
    if (stable >= 8 && all.length > 4) { console.log(">>> events stable, stopping"); break; }
    await new Promise((r) => setTimeout(r, 2000));
  }

  hr("4. extracted output");
  console.log("finished:", finished, "| total events:", all.length);
  const output = extractFinalOutput(all);
  console.log("extractFinalOutput():", output || "(EMPTY)");
  if (output) {
    try { console.log("parsed:", JSON.stringify(JSON.parse(output))); } catch { /* not json */ }
  }
}

main().catch((e) => { console.error("DIAGNOSTIC ERROR:", e); process.exit(1); });

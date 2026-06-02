/**
 * Drive one Claude Managed Agents session end-to-end and print the extracted
 * `{body}` — the agent-side analogue of the old scripts/twin-diagnose.ts.
 *
 * Usage:
 *   npx tsx scripts/agent-diagnose.ts <agent_id> [environment_id]
 *
 * Falls back to ANTHROPIC_DEFAULT_ENVIRONMENT_ID for the environment.
 * Requires ANTHROPIC_API_KEY in the environment.
 *
 * The fixture target is SYNTHETIC — no real recipient PII — and the raw
 * transcript is intentionally not dumped (session transcripts are retained
 * server-side; see the plan's data-residency note).
 */
import { runAgentJson, listAgentSessions, AgentError } from "@/lib/agent-session";

async function main() {
  const agentId = process.argv[2];
  const environmentId =
    process.argv[3] || process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID;

  if (!agentId) {
    console.error("Usage: npx tsx scripts/agent-diagnose.ts <agent_id> [environment_id]");
    process.exit(1);
  }
  if (!environmentId) {
    console.error(
      "No environment_id given and ANTHROPIC_DEFAULT_ENVIRONMENT_ID is unset.",
    );
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  // Synthetic personalize goal — the exact structured shape personalizeBlock sends.
  const goal = {
    mode: "personalize",
    block_type: "Html",
    original_content: "<p>Welcome aboard. We're glad to have you.</p>",
    prompt: "Personalize this for the target using their name and company.",
    target: {
      first_name: "Test",
      last_name: "Persona",
      company: "Diagnostics Inc",
      role: "Operations Lead",
    },
  };

  console.log(`Running a session on agent=${agentId} env=${environmentId} ...`);
  const start = Date.now();
  try {
    const result = await runAgentJson(agentId, environmentId, JSON.stringify(goal), {
      timeoutMs: 5 * 60 * 1000,
    });
    console.log(`\n✅ Session finished in ${Math.round((Date.now() - start) / 1000)}s`);
    console.log("Extracted output:");
    console.log(JSON.stringify(result, null, 2));
    if (typeof result.body !== "string") {
      console.warn(
        "\n⚠️  Output has no string `body` — the agent's prompt may not return the expected {body} shape.",
      );
    }

    const sessions = await listAgentSessions(agentId, { limit: 3 });
    console.log(`\nRecent sessions (newest first): ${sessions.length}`);
    for (const s of sessions) {
      console.log(`  ${s.id}  ${s.status}  ${s.created_at}`);
    }
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`\n❌ AgentError ${err.status}: ${err.message}`);
    } else {
      console.error("\n❌ Failed:", err);
    }
    process.exit(1);
  }
}

main();

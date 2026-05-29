import { verifyCronSecret } from "@/lib/cron-utils";
import { sql } from "@/lib/db";
import { generateContent } from "@/lib/twin";
import { sanitizeEmailHtml } from "@/lib/html-sanitize";
import { claimScheduledCampaigns } from "@/lib/queries/system";
import { jsonResponse } from "@/lib/utils";

export const maxDuration = 800;


type Row = Record<string, any>;

const BATCH_SIZE = 50;
const MAX_CONCURRENT_CALLS = 10;
// Stop fetching new pages once we're this close to maxDuration so the function
// flushes what it has and returns cleanly instead of being killed mid-insert.
const GUARD_TIMEOUT_MS = 720_000;

interface GeneratedEmail {
  target_id: string;
  email: string;
  subject: string;
  body: string;
}

/**
 * Insert one page of generated emails. Mirrors the campaign de-dupe guard:
 * ON CONFLICT (campaign_id, target_id) DO NOTHING so re-runs don't double-send.
 */
async function flushEmailSends(
  orgId: string,
  campaignId: string,
  rows: GeneratedEmail[],
): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const valueClauses: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const offset = i * 6;
    valueClauses.push(
      `($${offset + 1}, $${offset + 2}::uuid, $${offset + 3}::uuid, $${offset + 4}, $${offset + 5}, $${offset + 6}, 'queued')`,
    );
    params.push(orgId, campaignId, r.target_id, r.email, r.subject, r.body);
  }
  const query = `
    INSERT INTO email_sends
      (organization_id, campaign_id, target_id, email, subject, body, status)
    VALUES ${valueClauses.join(", ")}
    ON CONFLICT (campaign_id, target_id)
    WHERE campaign_id IS NOT NULL AND target_id IS NOT NULL AND status NOT IN ('failed', 'bounced')
    DO NOTHING
  `;
  await sql.query(query, params);
}

async function executeCampaign(
  campaignId: string,
  orgId: string,
  agentId: string,
  apiKey: string | undefined,
  startTime: number,
): Promise<{ queued: number; failed: number; timed_out: boolean }> {
  let queued = 0;
  let failedCount = 0;
  let timedOut = false;
  // Keyset cursor over targets.id (PK, stable btree order). Avoids loading the
  // whole active-target set into memory and lets us flush progress per page.
  let lastId: string | null = null;

  while (true) {
    if (Date.now() - startTime > GUARD_TIMEOUT_MS) {
      timedOut = true;
      break;
    }

    const page: Row[] = lastId
      ? await sql`
          SELECT * FROM targets
          WHERE organization_id = ${orgId} AND status = 'active' AND id > ${lastId}::uuid
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}
        `
      : await sql`
          SELECT * FROM targets
          WHERE organization_id = ${orgId} AND status = 'active'
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}
        `;

    if (page.length === 0) break;
    lastId = String(page[page.length - 1].id);

    // Generate content for the page with bounded concurrency.
    let active = 0;
    const promises = page.map(async (target) => {
      while (active >= MAX_CONCURRENT_CALLS) {
        await new Promise((r) => setTimeout(r, 10));
      }
      active++;
      try {
        const content = await generateContent(
          agentId,
          {
            email: target.email || "",
            first_name: target.first_name || "",
            last_name: target.last_name || "",
            company: target.company || "",
            lifecycle_stage: target.lifecycle_stage ?? 0,
          },
          "educational",
          { apiKey },
        );
        return {
          target_id: String(target.id),
          email: target.email as string,
          subject: (content.subject as string) || "",
          // AI output is untrusted — sanitize before it is stored/sent.
          body: sanitizeEmailHtml((content.body as string) || ""),
        };
      } catch (err) {
        failedCount++;
        console.error(
          `AI content generation failed for target ${target.id} (${target.email}):`,
          err,
        );
        return null;
      } finally {
        active--;
      }
    });

    const settled = await Promise.allSettled(promises);
    const pageResults: GeneratedEmail[] = [];
    for (const result of settled) {
      if (result.status === "fulfilled" && result.value) {
        const subject = (result.value.subject || "").trim();
        const body = (result.value.body || "").trim();
        if (!subject || !body) {
          failedCount++;
          console.warn(
            `Skipping target ${result.value.target_id} (${result.value.email}): empty subject or body from AI`,
          );
          continue;
        }
        pageResults.push(result.value);
      } else if (result.status === "rejected") {
        failedCount++;
      }
    }

    // Flush this page before fetching the next, so a later timeout/crash
    // doesn't discard already-generated emails.
    await flushEmailSends(orgId, campaignId, pageResults);
    queued += pageResults.length;

    if (page.length < BATCH_SIZE) break; // last page
  }

  console.log(
    `Campaign ${campaignId}: queued ${queued} email(s), ${failedCount} failed${
      timedOut ? " (stopped early at guard timeout)" : ""
    }`,
  );
  return { queued, failed: failedCount, timed_out: timedOut };
}

export async function GET(request: Request) {
  const authError = verifyCronSecret(request);
  if (authError) return authError;

  const startTime = Date.now();

  // Atomically claim scheduled campaigns (sets status='active' + processing_started_at)
  const campaigns = await claimScheduledCampaigns(10);

  if (campaigns.length === 0) {
    return jsonResponse({ campaigns_processed: 0, results: [] });
  }

  console.log(`Claimed ${campaigns.length} scheduled campaign(s)`);

  const results: Array<{
    campaign_id: string;
    result: { queued: number; failed: number; timed_out: boolean };
  }> = [];

  for (const campaign of campaigns) {
    // Stop starting new campaigns once we're near the function budget. The
    // claimed-but-unprocessed campaigns stay status='active' and get retried
    // on the next tick (processing_started_at reclaim window).
    if (Date.now() - startTime > GUARD_TIMEOUT_MS) {
      console.warn(
        `Approaching maxDuration after ${Date.now() - startTime}ms; deferring ${
          campaigns.length - results.length
        } remaining campaign(s) to the next tick`,
      );
      break;
    }

    const apiKey =
      typeof campaign.twin_api_key === "string" &&
      campaign.twin_api_key.length > 0
        ? (campaign.twin_api_key as string)
        : undefined;
    const result = await executeCampaign(
      String(campaign.id),
      String(campaign.organization_id),
      campaign.twin_agent_id,
      apiKey,
      startTime,
    );

    results.push({ campaign_id: String(campaign.id), result });
  }

  return jsonResponse({
    campaigns_processed: results.length,
    results,
  });
}

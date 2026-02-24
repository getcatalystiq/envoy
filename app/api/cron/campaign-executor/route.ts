import { verifyCronSecret } from "@/lib/cron-utils";
import { sql } from "@/lib/db";
import { invokeSkill } from "@/lib/agentplane";
import { claimScheduledCampaigns } from "@/lib/queries/system";
import { jsonResponse } from "@/lib/utils";

export const maxDuration = 800;

const BATCH_SIZE = 50;
const MAX_CONCURRENT_CALLS = 10;

async function executeCampaign(
  campaignId: string,
  orgId: string,
  agentId: string
): Promise<{ queued: number; failed: number }> {
  // Fetch active targets for the org
  const targets = await sql`
    SELECT * FROM targets
    WHERE organization_id = ${orgId} AND status = 'active'
  `;

  console.log(
    `Campaign ${campaignId}: ${targets.length} active target(s) to process`
  );

  let failedCount = 0;
  const results: Array<{
    target_id: string;
    email: string;
    subject: string;
    body: string;
  }> = [];

  // Process targets in batches with bounded concurrency
  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE);

    // Process batch with concurrency limit using Promise.allSettled
    let active = 0;
    const batchPromises = batch.map(async (target) => {
      while (active >= MAX_CONCURRENT_CALLS) {
        await new Promise((r) => setTimeout(r, 10));
      }
      active++;

      try {
        const content = await invokeSkill(
          agentId,
          "envoy-content-generation",
          {
            target: {
              email: target.email || "",
              first_name: target.first_name || "",
              last_name: target.last_name || "",
              company: target.company || "",
              lifecycle_stage: target.lifecycle_stage ?? 0,
            },
            context: { content_type: "educational" },
          }
        );

        return {
          target_id: String(target.id),
          email: target.email as string,
          subject: (content.subject as string) || "",
          body: (content.body as string) || "",
        };
      } catch (err) {
        failedCount++;
        console.error(
          `AI content generation failed for target ${target.id} (${target.email}):`,
          err
        );
        return null;
      } finally {
        active--;
      }
    });

    const batchResults = await Promise.allSettled(batchPromises);
    for (const settled of batchResults) {
      if (settled.status === "fulfilled" && settled.value) {
        results.push(settled.value);
      } else if (settled.status === "rejected") {
        failedCount++;
      }
    }
  }

  // Batch insert email sends
  if (results.length > 0) {
    // Build batch VALUES for a single INSERT
    const params: unknown[] = [];
    const valueClauses: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const offset = i * 6;
      valueClauses.push(
        `($${offset + 1}, $${offset + 2}::uuid, $${offset + 3}::uuid, $${offset + 4}, $${offset + 5}, $${offset + 6}, 'queued')`
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

  console.log(
    `Campaign ${campaignId}: queued ${results.length} email(s), ${failedCount} failed`
  );
  return { queued: results.length, failed: failedCount };
}

export async function GET(request: Request) {
  const authError = verifyCronSecret(request);
  if (authError) return authError;

  // Atomically claim scheduled campaigns (sets status='active' + processing_started_at)
  const campaigns = await claimScheduledCampaigns(10);

  if (campaigns.length === 0) {
    return jsonResponse({ campaigns_processed: 0, results: [] });
  }

  console.log(`Claimed ${campaigns.length} scheduled campaign(s)`);

  const results: Array<{
    campaign_id: string;
    result: { queued: number; failed: number };
  }> = [];

  for (const campaign of campaigns) {
    const result = await executeCampaign(
      String(campaign.id),
      String(campaign.organization_id),
      campaign.agentplane_agent_id
    );

    results.push({ campaign_id: String(campaign.id), result });
  }

  return jsonResponse({
    campaigns_processed: results.length,
    results,
  });
}

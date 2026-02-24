import { verifyCronSecret } from "@/lib/cron-utils";
import { sql } from "@/lib/db";
import { invokeSkill } from "@/lib/agentplane";
import { compileBuilderContent } from "@/lib/block-compiler";
import { wrapEmailBody } from "@/lib/email";
import {
  hasPersonalizedBlocks,
  processPersonalization,
} from "@/lib/personalization";
import { getDueEnrollments } from "@/lib/queries/system";
import * as outboxQueries from "@/lib/queries/outbox";
import * as seqQueries from "@/lib/queries/sequences";
import { replaceTemplatesInBlocks } from "@/lib/template-engine";
import { jsonResponse } from "@/lib/utils";

export const maxDuration = 800;

const BATCH_SIZE = 100;
const MAX_CONCURRENT_PROCESSING = 10;
const AI_TIMEOUT_MS = 45_000; // 45s per AI call
const GUARD_TIMEOUT_MS = 780_000; // 780s hard stop

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function checkExitConditions(
  enrollment: Row
): { status: string; reason: string } | null {
  const targetStatus = enrollment.target_status;
  if (targetStatus === "converted")
    return { status: "converted", reason: "converted" };
  if (targetStatus === "unsubscribed")
    return { status: "exited", reason: "unsubscribed" };
  if (targetStatus === "bounced")
    return { status: "exited", reason: "bounced" };
  return null;
}

async function processEnrollment(
  enrollment: Row,
  agentId: string | null
): Promise<Row> {
  const orgId = String(enrollment.organization_id);
  const enrollmentId = String(enrollment.id);
  const targetEmail = enrollment.target_email || "unknown";

  console.log(
    `Processing enrollment ${enrollmentId} for target ${targetEmail} (org=${orgId})`
  );

  // Check exit conditions
  const exitResult = checkExitConditions(enrollment);
  if (exitResult) {
    await seqQueries.completeEnrollment(
      orgId,
      enrollmentId,
      exitResult.status,
      exitResult.reason
    );
    console.log(`Enrollment ${enrollmentId} exited: ${exitResult.reason}`);
    return {
      enrollment_id: enrollmentId,
      action: "exited",
      reason: exitResult.reason,
    };
  }

  // Get current step
  const step = await seqQueries.getStepByPosition(
    orgId,
    String(enrollment.sequence_id),
    enrollment.current_step_position
  );

  if (!step) {
    await seqQueries.completeEnrollment(orgId, enrollmentId, "completed");
    console.log(`Enrollment ${enrollmentId} completed: no more steps`);
    return {
      enrollment_id: enrollmentId,
      action: "completed",
      reason: "no_more_steps",
    };
  }

  // Get content for step
  const content = await seqQueries.getStepContent(orgId, String(step.id));

  if (!content) {
    // No content, skip step
    await seqQueries.recordExecution(
      orgId,
      enrollmentId,
      enrollment.current_step_position,
      { status: "skipped" }
    );

    const nextStep = await seqQueries.getStepByPosition(
      orgId,
      String(enrollment.sequence_id),
      enrollment.current_step_position + 1
    );

    if (nextStep) {
      await seqQueries.advanceEnrollment(
        orgId,
        enrollmentId,
        nextStep.default_delay_hours
      );
      console.log(
        `Enrollment ${enrollmentId} skipped step ${enrollment.current_step_position}: no content`
      );
      return {
        enrollment_id: enrollmentId,
        action: "skipped",
        reason: "no_content",
      };
    } else {
      await seqQueries.completeEnrollment(orgId, enrollmentId, "completed");
      console.log(
        `Enrollment ${enrollmentId} completed (no content on last step)`
      );
      return { enrollment_id: enrollmentId, action: "completed" };
    }
  }

  const subject = content.content_subject || "";

  // Process builder_content or fallback to legacy content_body
  let body: string;
  let builderContent = step.builder_content;

  if (
    builderContent &&
    typeof builderContent === "object" &&
    Object.keys(builderContent).length > 0
  ) {
    // Replace template variables ({{first_name}}, etc.) in all blocks
    const targetDataForTemplates: Record<string, string | undefined | null> = {
      email: enrollment.target_email,
      first_name: enrollment.target_first_name,
      last_name: enrollment.target_last_name,
      company: enrollment.target_company,
      phone: enrollment.target_phone,
    };

    builderContent = replaceTemplatesInBlocks(
      builderContent,
      targetDataForTemplates,
      String(enrollment.target_id)
    );

    // Process block-level AI personalization if configured
    const hasPersonalized = hasPersonalizedBlocks(builderContent);
    if (hasPersonalized && agentId) {
      console.log(
        `Starting AI personalization for enrollment ${enrollmentId} (${targetEmail})`
      );
      const targetData = {
        email: enrollment.target_email,
        first_name: enrollment.target_first_name,
        last_name: enrollment.target_last_name,
        company: enrollment.target_company,
        phone: enrollment.target_phone,
        metadata: enrollment.target_metadata,
      };
      const personalizationResult = await processPersonalization(
        builderContent,
        targetData,
        agentId,
        { maxConcurrent: 5, timeoutMs: AI_TIMEOUT_MS }
      );
      builderContent = personalizationResult.content;
      if (personalizationResult.errors.length > 0) {
        console.warn(
          `Personalization had ${personalizationResult.errors.length} error(s) for enrollment ${enrollmentId}: ${personalizationResult.errors.map((e) => `${e.blockId}: ${e.error}`).join("; ")}`
        );
      } else {
        console.log(
          `Personalization succeeded for enrollment ${enrollmentId}`
        );
      }
    } else if (hasPersonalized && !agentId) {
      console.warn(
        `Enrollment ${enrollmentId} has personalized blocks but AgentPlane not configured for org ${orgId}`
      );
    }

    // Compile builder_content to HTML and wrap
    body = compileBuilderContent(builderContent);
    body = wrapEmailBody(body);
  } else {
    // Fallback to legacy content_body
    body = content.content_body || "";
    console.log(`Enrollment ${enrollmentId}: using legacy content_body`);
  }

  // If AI agent is configured and we still have no body, try generating
  if (agentId && !body) {
    try {
      const aiResult = await invokeSkill(
        agentId,
        "envoy-content-generation",
        {
          mode: "block_personalization",
          target: {
            email: enrollment.target_email,
            first_name: enrollment.target_first_name,
            last_name: enrollment.target_last_name,
            company: enrollment.target_company,
          },
          context: { content_type: "sequence_step" },
        }
      );
      body =
        (aiResult.body as string) || (aiResult.content as string) || "";
    } catch (err) {
      console.error(
        `AI content generation failed for enrollment ${enrollmentId}:`,
        err
      );
    }
  }

  // Determine approval status
  const approvalRequired = content.approval_required !== false;
  const outboxStatus = approvalRequired ? "pending" : "approved";

  // Create outbox item
  const outboxItem = await outboxQueries.create(
    orgId,
    String(enrollment.target_id),
    "email",
    body,
    {
      subject,
      priority: 5,
      status: outboxStatus,
    }
  );

  console.log(
    `Created outbox item ${outboxItem.id} for enrollment ${enrollmentId} (status=${outboxStatus})`
  );

  // If auto-approved, create email_sends record immediately
  if (!approvalRequired) {
    await sql`
      INSERT INTO email_sends
        (organization_id, target_id, email, subject, body, status, outbox_id)
      SELECT ${orgId}, ${String(enrollment.target_id)}::uuid, t.email,
             ${subject || ""}, ${body}, 'queued', ${String(outboxItem.id)}::uuid
      FROM targets t WHERE t.id = ${String(enrollment.target_id)}::uuid
    `;
    console.log(
      `Auto-approved and queued email for enrollment ${enrollmentId} (outbox=${outboxItem.id})`
    );
  }

  // Record step execution
  await seqQueries.recordExecution(
    orgId,
    enrollmentId,
    enrollment.current_step_position,
    { outboxId: String(outboxItem.id), status: "executed" }
  );

  // Check for next step
  const nextStep = await seqQueries.getStepByPosition(
    orgId,
    String(enrollment.sequence_id),
    enrollment.current_step_position + 1
  );

  if (nextStep) {
    await seqQueries.advanceEnrollment(
      orgId,
      enrollmentId,
      nextStep.default_delay_hours
    );
  } else {
    await seqQueries.completeEnrollment(orgId, enrollmentId, "completed");
  }

  return {
    enrollment_id: enrollmentId,
    action: "queued_for_approval",
    outbox_id: String(outboxItem.id),
  };
}

export async function GET(request: Request) {
  const authError = verifyCronSecret(request);
  if (authError) return authError;

  const startTime = Date.now();

  // Get due enrollments (FOR UPDATE SKIP LOCKED, atomically claims)
  const enrollments = await getDueEnrollments(BATCH_SIZE);

  if (enrollments.length === 0) {
    return jsonResponse({ processed: 0, results: [] });
  }

  console.log(`Found ${enrollments.length} due enrollment(s)`);

  // Group by organization for agent reuse
  const orgEnrollments: Record<string, Row[]> = {};
  for (const e of enrollments) {
    const orgId = String(e.organization_id);
    if (!orgEnrollments[orgId]) orgEnrollments[orgId] = [];
    orgEnrollments[orgId].push(e);
  }

  const results: Row[] = [];

  for (const [orgId, orgEnrollmentList] of Object.entries(orgEnrollments)) {
    // 780s guard: stop processing if approaching timeout
    if (Date.now() - startTime > GUARD_TIMEOUT_MS) {
      console.warn(
        `Approaching timeout after ${Date.now() - startTime}ms, stopping processing`
      );
      break;
    }

    const first = orgEnrollmentList[0];
    const agentId = first.agentplane_agent_id || null;

    if (agentId) {
      console.log(
        `AgentPlane configured for org ${orgId} (agent=${agentId})`
      );
    } else {
      console.warn(
        `AgentPlane NOT configured for org ${orgId} - AI personalization disabled`
      );
    }

    // Process with bounded concurrency using Promise.allSettled
    let active = 0;
    const promises = orgEnrollmentList.map(async (enrollment) => {
      // 780s guard per-item
      if (Date.now() - startTime > GUARD_TIMEOUT_MS) {
        return {
          enrollment_id: String(enrollment.id),
          action: "skipped",
          reason: "timeout_guard",
        };
      }

      while (active >= MAX_CONCURRENT_PROCESSING) {
        await new Promise((r) => setTimeout(r, 10));
      }
      active++;

      try {
        return await processEnrollment(enrollment, agentId);
      } catch (err) {
        console.error(
          `Error processing enrollment ${enrollment.id}:`,
          err
        );
        return {
          enrollment_id: String(enrollment.id),
          action: "error",
          error: String(err),
        };
      } finally {
        active--;
      }
    });

    const orgResults = await Promise.allSettled(promises);
    for (const settled of orgResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      } else {
        results.push({
          action: "error",
          error: String(settled.reason),
        });
      }
    }
  }

  const errorCount = results.filter((r) => r.action === "error").length;
  console.log(
    `Processed ${results.length} enrollment(s), ${errorCount} error(s) in ${Date.now() - startTime}ms`
  );

  return jsonResponse({ processed: results.length, results });
}

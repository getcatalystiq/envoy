import { verifyCronSecret } from "@/lib/cron-utils";
import { sql } from "@/lib/db";
import * as twin from "@/lib/twin";
import { runAgentJson, startRun } from "@/lib/twin";
import { sanitizeTargetForTwin } from "@/lib/twin-sanitize";
import { compileBuilderContent } from "@/lib/block-compiler";
import { wrapEmailBody } from "@/lib/email";
import {
  hasPersonalizedBlocks,
  processPersonalization,
} from "@/lib/personalization";
import { getDueEnrollments, resetSkippedEnrollments } from "@/lib/queries/system";
import * as outboxQueries from "@/lib/queries/outbox";
import * as seqQueries from "@/lib/queries/sequences";
import { replaceTemplatesInBlocks } from "@/lib/template-engine";
import { jsonResponse } from "@/lib/utils";

export const maxDuration = 800;

const BATCH_SIZE = 100;
// Lower fan-out to reduce concurrent polling pressure on Twin.
const MAX_CONCURRENT_PROCESSING = 5;
// Give polling realistic budget headroom; per-block AI calls poll Twin.
const AI_TIMEOUT_MS = 90_000;
const GUARD_TIMEOUT_MS = 780_000; // 780s hard stop

 
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
  agentId: string | null,
  apiKey: string | undefined,
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
        apiKey,
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
        `Enrollment ${enrollmentId} has personalized blocks but Twin agent not configured for org ${orgId}`
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

  // If AI agent is configured and we still have no body, try generating.
  // The output is unreviewed raw AI text, so we HTML-escape it and wrap it
  // through the same email body pipeline used for builder_content.
  //
  // Idempotency: if a prior cron tick already kicked off a Twin run for this
  // (enrollment, step), resume polling that run instead of starting a new one.
  // Otherwise startRun ourselves and persist the run_id BEFORE the long poll
  // so a crash mid-poll doesn't double-bill on the next tick.
  if (agentId && !body) {
    try {
      const target = {
        email: enrollment.target_email,
        first_name: enrollment.target_first_name,
        last_name: enrollment.target_last_name,
        company: enrollment.target_company,
      };
      const message =
        `Generate the next sequence step email for this target.\n\n` +
        `Target:\n${JSON.stringify(sanitizeTargetForTwin(target), null, 2)}\n\n` +
        `Respond with JSON containing a "body" field with the email content.`;

      const stepPosition = enrollment.current_step_position;
      let runId = await seqQueries.getInflightTwinRunId(
        orgId,
        enrollmentId,
        stepPosition
      );

      if (runId) {
        console.log(
          `Resuming inflight Twin run ${runId} for enrollment ${enrollmentId} step ${stepPosition}`
        );
      } else {
        const startedRun = await startRun(agentId, {
          runMode: "run",
          userMessage: message,
          apiKey,
        });
        runId = startedRun.run_id;
        try {
          await seqQueries.setStepExecutionTwinRunId(
            orgId,
            enrollmentId,
            stepPosition,
            runId
          );
        } catch (persistErr) {
          // DB couldn't track us — cancel the started run so it doesn't keep
          // running on the Twin side. We re-throw so the outer catch logs.
          await twin
            .cancelRun(agentId, runId, "persist-failed", { apiKey })
            .catch(() => {});
          throw persistErr;
        }
      }

      const aiResult = await runAgentJson(agentId, message, {
        existingRunId: runId,
        apiKey,
      });
      const rawBody =
        (aiResult.body as string) || (aiResult.content as string) || "";
      if (rawBody) {
        const escaped = rawBody
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>");
        body = wrapEmailBody(escaped);
      }
      // Note: the inflight marker is cleared at the end of processEnrollment
      // (after outbox.create + recordExecution succeed). This way a crash
      // between AI generation and outbox persistence leaves the marker in
      // place so the next tick resumes the same Twin run instead of
      // double-billing.
    } catch (err) {
      console.error(
        `AI content generation failed for enrollment ${enrollmentId}:`,
        err
      );
      // Leave the twin_run_id in place so the next tick can resume it.
    }
  }

  // If we used the AI path but it produced no body, skip the send and
  // advance the enrollment rather than queuing an empty email.
  if (agentId && !body) {
    console.warn(
      `Enrollment ${enrollmentId} has empty body after AI generation — skipping send and advancing step`
    );
    await seqQueries.recordExecution(
      orgId,
      enrollmentId,
      enrollment.current_step_position,
      { status: "skipped" }
    );
    // Clear the inflight marker; the AI run produced no usable output.
    await seqQueries.clearStepExecutionTwinRunId(
      orgId,
      enrollmentId,
      enrollment.current_step_position
    );
    const nextStepSkip = await seqQueries.getStepByPosition(
      orgId,
      String(enrollment.sequence_id),
      enrollment.current_step_position + 1
    );
    if (nextStepSkip) {
      await seqQueries.advanceEnrollment(
        orgId,
        enrollmentId,
        nextStepSkip.default_delay_hours
      );
    } else {
      await seqQueries.completeEnrollment(orgId, enrollmentId, "completed");
    }
    return {
      enrollment_id: enrollmentId,
      action: "skipped",
      reason: "empty_ai_output",
    };
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

  // Outbox + execution successfully persisted: now safe to clear any
  // inflight Twin run marker. The clear is a no-op when no tracking row
  // exists (DELETE WHERE matches zero rows).
  await seqQueries.clearStepExecutionTwinRunId(
    orgId,
    enrollmentId,
    enrollment.current_step_position
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
  const skippedIds: string[] = [];
  const orgEntries = Object.entries(orgEnrollments);
  let stoppedAtOrgIndex = orgEntries.length;

  for (let orgIdx = 0; orgIdx < orgEntries.length; orgIdx++) {
    const [orgId, orgEnrollmentList] = orgEntries[orgIdx];
    // 780s guard: stop processing if approaching timeout
    if (Date.now() - startTime > GUARD_TIMEOUT_MS) {
      console.warn(
        `Approaching timeout after ${Date.now() - startTime}ms, stopping processing`
      );
      stoppedAtOrgIndex = orgIdx;
      break;
    }

    const first = orgEnrollmentList[0];
    const agentId = first.twin_agent_id || null;
    // Per-org Twin API key overrides the env-var fallback. Pass undefined and
    // let lib/twin's twinFetch read env.TWIN_API_KEY when this is null/empty.
    const apiKey =
      (typeof first.twin_api_key === "string" && first.twin_api_key.length > 0)
        ? (first.twin_api_key as string)
        : undefined;

    if (agentId) {
      console.log(
        `Twin agent configured for org ${orgId} (agent=${agentId})`
      );
    } else {
      console.warn(
        `Twin agent NOT configured for org ${orgId} - AI personalization disabled`
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
        return await processEnrollment(enrollment, agentId, apiKey);
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
        if (
          settled.value.action === "skipped" &&
          settled.value.reason === "timeout_guard" &&
          settled.value.enrollment_id
        ) {
          skippedIds.push(String(settled.value.enrollment_id));
        }
      } else {
        results.push({
          action: "error",
          error: String(settled.reason),
        });
      }
    }
  }

  // Capture any orgs we never reached because of the outer-loop guard break.
  for (let orgIdx = stoppedAtOrgIndex; orgIdx < orgEntries.length; orgIdx++) {
    const [, orgEnrollmentList] = orgEntries[orgIdx];
    for (const e of orgEnrollmentList) {
      const id = String(e.id);
      skippedIds.push(id);
      results.push({
        enrollment_id: id,
        action: "skipped",
        reason: "timeout_guard",
      });
    }
  }

  if (skippedIds.length > 0) {
    try {
      await resetSkippedEnrollments(skippedIds);
    } catch (err) {
      console.error(
        `Failed to reset next_evaluation_at for ${skippedIds.length} skipped enrollment(s):`,
        err
      );
    }
  }

  const errorCount = results.filter((r) => r.action === "error").length;
  console.log(
    `Processed ${results.length} enrollment(s), ${errorCount} error(s) in ${Date.now() - startTime}ms`
  );

  return jsonResponse({ processed: results.length, results });
}

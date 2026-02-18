"""Sequence scheduler Lambda handler for processing sequence enrollments."""

import asyncio
import logging
from typing import Any, Optional

# Lambda logging setup - force root logger to INFO so all loggers emit
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)

from shared.agentplane_client import AgentPlaneClient
from shared.database import get_pool
from shared.email_wrapper import wrap_email_body
from shared.queries import OutboxQueries, SequenceQueries
from shared.ses_client import SESClient

from block_compiler import compile_builder_content
from personalization import has_personalized_blocks, process_personalization
from template_engine import replace_templates_in_blocks

BATCH_SIZE = 100

MAX_CONCURRENT_PROCESSING = 10


async def check_exit_conditions(target: dict) -> Optional[tuple[str, str]]:
    """Check if target should exit the sequence.

    Returns (status, reason) tuple if should exit, None otherwise.
    """
    target_status = target.get("target_status")
    if target_status == "converted":
        return ("converted", "converted")
    if target_status == "unsubscribed":
        return ("exited", "unsubscribed")
    if target_status == "bounced":
        return ("exited", "bounced")
    return None


async def process_enrollment(
    pool: Any,
    enrollment: dict,
    agentplane: Optional[AgentPlaneClient],
    ses: SESClient,
) -> dict[str, Any]:
    """Process a single enrollment."""
    org_id = str(enrollment["organization_id"])
    enrollment_id = enrollment["id"]
    target_email = enrollment.get("target_email", "unknown")

    logger.info("Processing enrollment %s for target %s (org=%s)", enrollment_id, target_email, org_id)

    async with pool.acquire() as conn:
        await conn.execute(f"SET app.current_org_id = '{org_id}'")

        try:
            # Check exit conditions
            exit_result = await check_exit_conditions(enrollment)
            if exit_result:
                status, reason = exit_result
                await SequenceQueries.complete_enrollment(
                    conn, enrollment_id, status=status, exit_reason=reason
                )
                logger.info("Enrollment %s exited: %s", enrollment_id, reason)
                return {"enrollment_id": str(enrollment_id), "action": "exited", "reason": reason}

            # Get current step
            step = await SequenceQueries.get_step_by_position(
                conn,
                enrollment["sequence_id"],
                enrollment["current_step_position"],
            )

            if not step:
                # Sequence was shortened, complete gracefully
                await SequenceQueries.complete_enrollment(
                    conn, enrollment_id, status="completed"
                )
                logger.info("Enrollment %s completed: no more steps", enrollment_id)
                return {"enrollment_id": str(enrollment_id), "action": "completed", "reason": "no_more_steps"}

            # Select content (priority-based)
            content = await SequenceQueries.get_step_content(conn, step["id"])

            if not content:
                # No content for step, skip it
                await SequenceQueries.record_execution(
                    conn,
                    org_id=org_id,
                    enrollment_id=enrollment_id,
                    step_position=enrollment["current_step_position"],
                    status="skipped",
                )

                # Check if there's a next step
                next_step = await SequenceQueries.get_step_by_position(
                    conn,
                    enrollment["sequence_id"],
                    enrollment["current_step_position"] + 1,
                )

                if next_step:
                    await SequenceQueries.advance_enrollment(
                        conn, enrollment_id, next_step["default_delay_hours"]
                    )
                    logger.info("Enrollment %s skipped step %d: no content", enrollment_id, enrollment["current_step_position"])
                    return {"enrollment_id": str(enrollment_id), "action": "skipped", "reason": "no_content"}
                else:
                    await SequenceQueries.complete_enrollment(
                        conn, enrollment_id, status="completed"
                    )
                    logger.info("Enrollment %s completed (no content on last step)", enrollment_id)
                    return {"enrollment_id": str(enrollment_id), "action": "completed"}

            # Get subject from content
            subject = content.get("content_subject", "")

            # Check for builder_content (new block-based email builder)
            builder_content = step.get("builder_content")
            if builder_content:
                # Replace template variables ({{first_name}}, etc.) in all blocks first
                target_data_for_templates = {
                    "email": enrollment.get("target_email"),
                    "first_name": enrollment.get("target_first_name"),
                    "last_name": enrollment.get("target_last_name"),
                    "company": enrollment.get("target_company"),
                    "phone": enrollment.get("target_phone"),
                }
                builder_content = replace_templates_in_blocks(
                    builder_content=builder_content,
                    target_data=target_data_for_templates,
                    target_id=str(enrollment["target_id"]),
                )

                # Process block-level personalization if any blocks have it enabled
                # Skip if AgentPlane is not configured for this organization
                has_personalized = has_personalized_blocks(builder_content)
                if has_personalized and agentplane is not None:
                    logger.info("Starting AI personalization for enrollment %s (%s)", enrollment_id, target_email)
                    target_data = {
                        "email": enrollment.get("target_email"),
                        "first_name": enrollment.get("target_first_name"),
                        "last_name": enrollment.get("target_last_name"),
                        "company": enrollment.get("target_company"),
                        "phone": enrollment.get("target_phone"),
                        "metadata": enrollment.get("target_metadata"),
                    }
                    builder_content, errors = await process_personalization(
                        builder_content=builder_content,
                        target_data=target_data,
                        ai_client=agentplane,
                    )
                    if errors:
                        logger.warning(
                            "Personalization had %d error(s) for enrollment %s: %s",
                            len(errors),
                            enrollment_id,
                            "; ".join(f"{e.block_id}: {e.error}" for e in errors),
                        )
                    else:
                        logger.info("Personalization succeeded for enrollment %s", enrollment_id)
                elif has_personalized and agentplane is None:
                    logger.warning(
                        "Enrollment %s has personalized blocks but AgentPlane is not configured for org %s",
                        enrollment_id,
                        org_id,
                    )
                else:
                    logger.info("Enrollment %s: no personalized blocks, skipping AI", enrollment_id)

                # Compile builder_content to HTML and wrap in document structure
                body = compile_builder_content(builder_content)
                body = wrap_email_body(body)
            else:
                # Fallback to legacy content_body
                logger.info("Enrollment %s: using legacy content_body", enrollment_id)
                body = content.get("content_body", "")

            # Determine if auto-approval is enabled for this step
            approval_required = content.get("approval_required", True)
            outbox_status = "pending" if approval_required else "approved"

            # Create outbox item with appropriate status
            outbox_item = await OutboxQueries.create(
                conn,
                org_id=org_id,
                target_id=enrollment["target_id"],
                channel="email",
                subject=subject,
                body=body,
                priority=5,
                status=outbox_status,
            )

            logger.info(
                "Created outbox item %s for enrollment %s (status=%s, subject=%s)",
                outbox_item["id"],
                enrollment_id,
                outbox_status,
                subject[:80] if subject else "(empty)",
            )

            # If auto-approved, create email_sends record immediately
            if not approval_required:
                await conn.execute(
                    """
                    INSERT INTO email_sends
                        (organization_id, target_id, email, subject, body, status, outbox_id)
                    SELECT $1, $2, t.email, $3, $4, 'queued', $5
                    FROM targets t WHERE t.id = $2
                    """,
                    org_id,
                    enrollment["target_id"],
                    subject or "",
                    body,
                    outbox_item["id"],
                )
                logger.info("Auto-approved and queued email for enrollment %s (outbox=%s)", enrollment_id, outbox_item["id"])

            # Record execution (outbox item created)
            await SequenceQueries.record_execution(
                conn,
                org_id=org_id,
                enrollment_id=enrollment_id,
                step_position=enrollment["current_step_position"],
                email_send_id=None,
                outbox_id=outbox_item["id"],
                status="executed",
            )

            # Check if there's a next step
            next_step = await SequenceQueries.get_step_by_position(
                conn,
                enrollment["sequence_id"],
                enrollment["current_step_position"] + 1,
            )

            if next_step:
                await SequenceQueries.advance_enrollment(
                    conn, enrollment_id, next_step["default_delay_hours"]
                )
            else:
                await SequenceQueries.complete_enrollment(
                    conn, enrollment_id, status="completed"
                )

            return {
                "enrollment_id": str(enrollment_id),
                "action": "queued_for_approval",
                "outbox_id": str(outbox_item["id"]),
            }

        finally:
            await conn.execute("RESET app.current_org_id")


async def process_due_enrollments() -> dict[str, Any]:
    """Process all enrollments due for evaluation."""
    pool = await get_pool()
    ses = SESClient()

    # Fetch due enrollments with row locking
    async with pool.acquire() as conn:
        enrollments = await SequenceQueries.get_due_enrollments(conn, limit=BATCH_SIZE)

    if not enrollments:
        logger.info("No due enrollments found")
        return {"processed": 0, "results": []}

    logger.info("Found %d due enrollment(s)", len(enrollments))

    # Group by organization for client reuse
    org_enrollments: dict[str, list[dict]] = {}
    for e in enrollments:
        org_id = str(e["organization_id"])
        if org_id not in org_enrollments:
            org_enrollments[org_id] = []
        org_enrollments[org_id].append(e)

    results = []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROCESSING)

    async def process_with_semaphore(enrollment: dict, client: AgentPlaneClient) -> dict:
        async with semaphore:
            try:
                return await process_enrollment(pool, enrollment, client, ses)
            except Exception:
                logger.exception("Error processing enrollment %s", enrollment["id"])
                return {
                    "enrollment_id": str(enrollment["id"]),
                    "action": "error",
                    "error": str(enrollment["id"]),
                }

    # Process each organization's enrollments
    for org_id, org_enrollments_list in org_enrollments.items():
        # Get AgentPlane config from first enrollment (same for all in org)
        first_enrollment = org_enrollments_list[0]
        agentplane_tenant_id = first_enrollment.get("agentplane_tenant_id") or org_id
        agentplane_agent_id = first_enrollment.get("agentplane_agent_id")

        # AgentPlane is optional - only create client if configured
        client = None
        if agentplane_agent_id:
            client = AgentPlaneClient(
                tenant_id=agentplane_tenant_id,
                agent_id=agentplane_agent_id,
            )
            logger.info("AgentPlane configured for org %s (agent=%s)", org_id, agentplane_agent_id)
        else:
            logger.warning("AgentPlane NOT configured for org %s - AI personalization disabled", org_id)

        org_results = await asyncio.gather(
            *[process_with_semaphore(e, client) for e in org_enrollments_list]
        )
        results.extend(org_results)

    error_count = sum(1 for r in results if r.get("action") == "error")
    logger.info("Processed %d enrollment(s), %d error(s)", len(results), error_count)

    return {
        "processed": len(results),
        "results": results,
    }


async def main() -> dict[str, Any]:
    """Main scheduler entry point."""
    result = await process_due_enrollments()
    logger.info("Sequence scheduler result: %s", result)
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

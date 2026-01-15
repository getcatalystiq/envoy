"""Sequence scheduler Lambda handler for processing sequence enrollments."""

import asyncio
import json
from typing import Any, Optional
from uuid import UUID

from shared.database import get_pool
from shared.maven_client import MavenClient
from shared.queries import OutboxQueries, SequenceQueries
from shared.ses_client import SESClient

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


async def personalize_content(
    maven: MavenClient,
    content: dict,
    target: dict,
    enrollment: dict,
) -> dict[str, Any]:
    """Personalize content using Maven AI."""
    try:
        result = await maven.invoke_skill(
            "envoy-sequence-personalize",
            {
                "template": {
                    "subject": content.get("content_subject", ""),
                    "body": content.get("content_body", ""),
                },
                "target": {
                    "email": target.get("target_email"),
                    "first_name": target.get("target_first_name"),
                    "last_name": target.get("target_last_name"),
                    "company": target.get("target_company"),
                    "data": target.get("target_custom_fields") or {},
                },
                "context": {
                    "sequence_name": enrollment.get("sequence_name"),
                    "step_position": enrollment.get("current_step_position"),
                },
            },
        )
        return {
            "subject": result.get("subject", content.get("content_subject", "")),
            "body": result.get("body", content.get("content_body", "")),
        }
    except Exception:
        # Fallback to original content on personalization failure
        return {
            "subject": content.get("content_subject", ""),
            "body": content.get("content_body", ""),
        }


async def process_enrollment(
    pool: Any,
    enrollment: dict,
    maven: MavenClient,
    ses: SESClient,
) -> dict[str, Any]:
    """Process a single enrollment."""
    org_id = str(enrollment["organization_id"])
    enrollment_id = enrollment["id"]

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
                    return {"enrollment_id": str(enrollment_id), "action": "skipped", "reason": "no_content"}
                else:
                    await SequenceQueries.complete_enrollment(
                        conn, enrollment_id, status="completed"
                    )
                    return {"enrollment_id": str(enrollment_id), "action": "completed"}

            # TODO: Re-enable personalization once Maven is configured
            # personalized = await personalize_content(maven, content, enrollment, enrollment)
            # For now, use content as-is
            subject = content.get("content_subject", "")
            body = content.get("content_body", "")

            # Create outbox item for approval
            outbox_item = await OutboxQueries.create(
                conn,
                org_id=org_id,
                target_id=enrollment["target_id"],
                channel="email",
                subject=subject,
                body=body,
                skill_name="sequence-scheduler",
                skill_reasoning=f"Step {enrollment['current_step_position']} of sequence '{enrollment.get('sequence_name', 'Unknown')}'",
                priority=5,
            )

            # Record execution (outbox item created, awaiting approval)
            await SequenceQueries.record_execution(
                conn,
                org_id=org_id,
                enrollment_id=enrollment_id,
                step_position=enrollment["current_step_position"],
                content_id=content["content_id"],
                email_send_id=None,  # Will be set when outbox item is approved and sent
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
        return {"processed": 0, "results": []}

    # Group by organization for Maven client reuse
    org_enrollments: dict[str, list[dict]] = {}
    for e in enrollments:
        org_id = str(e["organization_id"])
        if org_id not in org_enrollments:
            org_enrollments[org_id] = []
        org_enrollments[org_id].append(e)

    results = []
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_PROCESSING)

    async def process_with_semaphore(enrollment: dict, maven: MavenClient) -> dict:
        async with semaphore:
            try:
                return await process_enrollment(pool, enrollment, maven, ses)
            except Exception as e:
                return {
                    "enrollment_id": str(enrollment["id"]),
                    "action": "error",
                    "error": str(e),
                }

    # Process each organization's enrollments
    for org_id, org_enrollments_list in org_enrollments.items():
        maven = MavenClient(tenant_id=org_id)

        org_results = await asyncio.gather(
            *[process_with_semaphore(e, maven) for e in org_enrollments_list]
        )
        results.extend(org_results)

    return {
        "processed": len(results),
        "results": results,
    }


async def main() -> dict[str, Any]:
    """Main scheduler entry point."""
    return await process_due_enrollments()


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

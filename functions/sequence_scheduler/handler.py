"""Sequence scheduler Lambda handler for processing sequence enrollments."""

import asyncio
import logging
from typing import Any, Optional

# Configure logging for local dev visibility
logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s:%(name)s:%(message)s",
)
logger = logging.getLogger(__name__)

from shared.database import get_pool
from shared.email_wrapper import wrap_email_body
from shared.maven_client import MavenClient
from shared.queries import OutboxQueries, SequenceQueries
from shared.ses_client import SESClient

from block_compiler import compile_builder_content
from personalization import has_personalized_blocks, process_personalization
from template_engine import replace_templates_in_blocks

BATCH_SIZE = 100


def _count_personalized(content: dict | None) -> int:
    """Helper to count blocks with personalization enabled."""
    if not content:
        return 0
    count = 0
    for block_id, block in content.items():
        p = block.get("data", {}).get("personalization", {})
        if p.get("enabled"):
            count += 1
    return count


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

            # Get subject from content
            subject = content.get("content_subject", "")

            # Check for builder_content (new block-based email builder)
            builder_content = step.get("builder_content")
            print(f"  [DEBUG] Step {step['id']} - builder_content type: {type(builder_content).__name__}, blocks: {len(builder_content) if builder_content else 0}")
            if builder_content:
                # Log personalization BEFORE template replacement
                before_count = _count_personalized(builder_content)
                print(f"  [DEBUG] BEFORE template replacement: {before_count} personalized blocks")

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

                # Log personalization AFTER template replacement
                after_count = _count_personalized(builder_content)
                print(f"  [DEBUG] AFTER template replacement: {after_count} personalized blocks")

                if before_count > 0 and after_count == 0:
                    print("  [DEBUG] BUG: Template replacement lost personalization data!")

                # Process block-level personalization if any blocks have it enabled
                if has_personalized_blocks(builder_content):
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
                        maven_client=maven,
                    )

                # Compile builder_content to HTML and wrap in document structure
                body = compile_builder_content(builder_content)
                body = wrap_email_body(body)
            else:
                # Fallback to legacy content_body
                body = content.get("content_body", "")

            # Create outbox item for approval
            outbox_item = await OutboxQueries.create(
                conn,
                org_id=org_id,
                target_id=enrollment["target_id"],
                channel="email",
                subject=subject,
                body=body,
                priority=5,
            )

            # Record execution (outbox item created, awaiting approval)
            # Note: content_id is omitted since content is stored directly on the step
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
        # Get Maven config from first enrollment (same for all in org)
        first_enrollment = org_enrollments_list[0]
        maven_tenant_id = first_enrollment.get("maven_tenant_id") or org_id
        maven_service_runtime_arn = first_enrollment.get("maven_service_runtime_arn")

        maven = MavenClient(
            tenant_id=maven_tenant_id,
            service_runtime_arn=maven_service_runtime_arn,
        )

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

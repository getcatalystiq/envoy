"""Email scheduler Lambda handler for batch campaign execution."""

import asyncio
import json
import os
from typing import Any

from shared.database import get_pool, get_transaction
from shared.maven_client import MavenClient
from shared.ses_client import SESClient

BATCH_SIZE = 50
MAX_CONCURRENT_MAVEN_CALLS = 10


async def execute_campaign(campaign_id: str, org_id: str, maven_tenant_id: str) -> dict[str, Any]:
    """Execute a campaign with batch processing and parallelization."""
    maven = MavenClient(tenant_id=maven_tenant_id)
    ses = SESClient()

    pool = await get_pool()

    # Fetch campaign and targets
    async with pool.acquire() as conn:
        await conn.execute(f"SET app.current_org_id = '{org_id}'")

        campaign = await conn.fetchrow(
            "SELECT * FROM campaigns WHERE id = $1", campaign_id
        )
        if not campaign:
            return {"error": "Campaign not found"}

        skills = json.loads(campaign["skills"]) if isinstance(campaign["skills"], str) else campaign["skills"]

        # Fetch targets with engagement history
        targets = await conn.fetch(
            """
            WITH target_engagements AS (
                SELECT
                    t.id as target_id,
                    COALESCE(json_agg(json_build_object(
                        'event_type', ee.event_type,
                        'occurred_at', ee.occurred_at
                    )) FILTER (WHERE ee.id IS NOT NULL), '[]') as engagements
                FROM targets t
                LEFT JOIN email_sends es ON es.target_id = t.id
                LEFT JOIN engagement_events ee ON ee.send_id = es.id
                WHERE t.organization_id = $1 AND t.status = 'active'
                GROUP BY t.id
            ),
            target_sends AS (
                SELECT target_id,
                    COALESCE(json_agg(json_build_object(
                        'sent_at', sent_at,
                        'opened_at', opened_at
                    ) ORDER BY sent_at DESC) FILTER (WHERE id IS NOT NULL), '[]') as past_sends
                FROM email_sends
                GROUP BY target_id
            )
            SELECT t.*, te.engagements, COALESCE(ts.past_sends, '[]') as past_sends
            FROM targets t
            LEFT JOIN target_engagements te ON te.target_id = t.id
            LEFT JOIN target_sends ts ON ts.target_id = t.id
            WHERE t.organization_id = $1 AND t.status = 'active'
            """,
            org_id,
        )

        await conn.execute("RESET app.current_org_id")

    # Process targets with bounded concurrency
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_MAVEN_CALLS)

    async def process_target(target: dict) -> dict | None:
        async with semaphore:
            try:
                # Parallel Maven calls
                stage_task = maven.assess_stage(
                    dict(target),
                    json.loads(target["engagements"]) if isinstance(target["engagements"], str) else target["engagements"],
                )
                content_task = maven.generate_content(
                    dict(target),
                    "educational",
                )
                timing_task = maven.get_optimal_timing(
                    dict(target),
                    json.loads(target["past_sends"]) if isinstance(target["past_sends"], str) else target["past_sends"],
                )

                stage, content, timing = await asyncio.gather(
                    stage_task, content_task, timing_task,
                    return_exceptions=True,
                )

                # Handle partial failures
                if isinstance(stage, Exception):
                    stage = {"stage": target["lifecycle_stage"]}
                if isinstance(content, Exception):
                    return None
                if isinstance(timing, Exception):
                    timing = {"recommended_time": None}

                return {
                    "target_id": str(target["id"]),
                    "email": target["email"],
                    "stage": stage,
                    "content": content,
                    "timing": timing,
                }
            except Exception:
                return None

    # Process in batches
    results = []
    for i in range(0, len(targets), BATCH_SIZE):
        batch = targets[i : i + BATCH_SIZE]
        batch_results = await asyncio.gather(
            *[process_target(dict(t)) for t in batch]
        )
        results.extend([r for r in batch_results if r])
        await asyncio.sleep(0)

    # Bulk insert email sends
    async with pool.acquire() as conn:
        await conn.execute(f"SET app.current_org_id = '{org_id}'")

        for r in results:
            await conn.execute(
                """
                INSERT INTO email_sends
                    (organization_id, campaign_id, target_id, email, subject, body, status, scheduled_at)
                VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
                ON CONFLICT (campaign_id, target_id)
                WHERE campaign_id IS NOT NULL AND target_id IS NOT NULL AND status NOT IN ('failed', 'bounced')
                DO NOTHING
                """,
                org_id,
                campaign_id,
                r["target_id"],
                r["email"],
                r["content"].get("subject", ""),
                r["content"].get("body", ""),
                r["timing"].get("recommended_time"),
            )

        await conn.execute("RESET app.current_org_id")

    return {"processed": len(results)}


async def process_scheduled_campaigns() -> dict[str, Any]:
    """Process all scheduled campaigns that are due."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Get scheduled campaigns (no RLS for this admin query)
        campaigns = await conn.fetch(
            """
            SELECT c.*, o.maven_tenant_id
            FROM campaigns c
            JOIN organizations o ON o.id = c.organization_id
            WHERE c.status = 'scheduled'
              AND c.scheduled_at <= NOW()
            ORDER BY c.scheduled_at ASC
            LIMIT 10
            """
        )

    results = []
    for campaign in campaigns:
        # Update status to active
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE campaigns
                SET status = 'active', started_at = NOW(), updated_at = NOW()
                WHERE id = $1
                """,
                campaign["id"],
            )

        # Execute campaign
        result = await execute_campaign(
            str(campaign["id"]),
            str(campaign["organization_id"]),
            str(campaign["maven_tenant_id"]) if campaign["maven_tenant_id"] else str(campaign["organization_id"]),
        )
        results.append({
            "campaign_id": str(campaign["id"]),
            "result": result,
        })

    return {"campaigns_processed": len(results), "results": results}


async def send_queued_emails() -> dict[str, Any]:
    """Send emails that are queued and scheduled for now."""
    pool = await get_pool()
    ses = SESClient()

    async with pool.acquire() as conn:
        # Get queued emails ready to send
        sends = await conn.fetch(
            """
            SELECT * FROM email_sends
            WHERE status = 'queued'
              AND (scheduled_at IS NULL OR scheduled_at <= NOW())
            ORDER BY created_at ASC
            LIMIT 100
            """
        )

    sent_count = 0
    failed_count = 0

    for send in sends:
        result = await ses.send_email(
            to_email=send["email"],
            subject=send["subject"],
            body_html=send["body"],
        )

        async with pool.acquire() as conn:
            if result["success"]:
                await conn.execute(
                    """
                    UPDATE email_sends
                    SET status = 'sent', ses_message_id = $1, sent_at = NOW()
                    WHERE id = $2
                    """,
                    result["message_id"],
                    send["id"],
                )
                sent_count += 1
            else:
                await conn.execute(
                    """
                    UPDATE email_sends SET status = 'failed' WHERE id = $1
                    """,
                    send["id"],
                )
                failed_count += 1

    return {"sent": sent_count, "failed": failed_count}


async def main() -> dict[str, Any]:
    """Main scheduler entry point."""
    # Process scheduled campaigns
    campaign_result = await process_scheduled_campaigns()

    # Send queued emails
    email_result = await send_queued_emails()

    return {
        "campaigns": campaign_result,
        "emails": email_result,
    }


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

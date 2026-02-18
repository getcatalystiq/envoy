"""Campaign executor Lambda handler for processing scheduled campaigns."""

import asyncio
import logging
from typing import Any

from shared.agentplane_client import AgentPlaneClient
from shared.database import get_pool

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)

BATCH_SIZE = 50
MAX_CONCURRENT_CALLS = 10


async def execute_campaign(
    campaign_id: str, org_id: str, tenant_id: str, agent_id: str
) -> dict[str, Any]:
    """Execute a campaign - generate content and queue emails for sending."""
    client = AgentPlaneClient(tenant_id=tenant_id, agent_id=agent_id)
    pool = await get_pool()

    logger.info("Executing campaign %s (org=%s, agent=%s)", campaign_id, org_id, agent_id)

    # Fetch campaign and targets
    async with pool.acquire() as conn:
        await conn.execute(f"SET app.current_org_id = '{org_id}'")

        campaign = await conn.fetchrow(
            "SELECT * FROM campaigns WHERE id = $1", campaign_id
        )
        if not campaign:
            logger.error("Campaign %s not found", campaign_id)
            return {"error": "Campaign not found"}

        # Fetch active targets
        targets = await conn.fetch(
            """
            SELECT *
            FROM targets
            WHERE organization_id = $1 AND status = 'active'
            """,
            org_id,
        )

        await conn.execute("RESET app.current_org_id")

    logger.info("Campaign %s: %d active target(s) to process", campaign_id, len(targets))

    # Process targets with bounded concurrency
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_CALLS)
    failed_count = 0

    async def process_target(target: dict) -> dict | None:
        nonlocal failed_count
        async with semaphore:
            try:
                content = await client.invoke_skill(
                    "envoy-content-generation",
                    {
                        "target": {
                            "email": target.get("email", ""),
                            "first_name": target.get("first_name", ""),
                            "last_name": target.get("last_name", ""),
                            "company": target.get("company", ""),
                            "lifecycle_stage": target.get("lifecycle_stage", 0),
                        },
                        "context": {"content_type": "educational"},
                    },
                )

                return {
                    "target_id": str(target["id"]),
                    "email": target["email"],
                    "content": content,
                }
            except Exception:
                failed_count += 1
                logger.exception("AI content generation failed for target %s (%s)", target["id"], target.get("email", ""))
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

    # Queue emails for sending
    async with pool.acquire() as conn:
        await conn.execute(f"SET app.current_org_id = '{org_id}'")

        for r in results:
            await conn.execute(
                """
                INSERT INTO email_sends
                    (organization_id, campaign_id, target_id, email, subject, body, status)
                VALUES ($1, $2, $3, $4, $5, $6, 'queued')
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
            )

        await conn.execute("RESET app.current_org_id")

    logger.info("Campaign %s: queued %d email(s), %d failed", campaign_id, len(results), failed_count)
    return {"queued": len(results), "failed": failed_count}


async def process_scheduled_campaigns() -> dict[str, Any]:
    """Process all scheduled campaigns that are due."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Get scheduled campaigns
        campaigns = await conn.fetch(
            """
            SELECT c.*, o.agentplane_tenant_id, o.agentplane_agent_id
            FROM campaigns c
            JOIN organizations o ON o.id = c.organization_id
            WHERE c.status = 'scheduled'
              AND c.scheduled_at <= NOW()
              AND o.agentplane_agent_id IS NOT NULL
            ORDER BY c.scheduled_at ASC
            LIMIT 10
            """
        )

    if not campaigns:
        logger.info("No scheduled campaigns to process")
    else:
        logger.info("Found %d scheduled campaign(s)", len(campaigns))

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
            str(campaign["agentplane_tenant_id"]) if campaign["agentplane_tenant_id"] else str(campaign["organization_id"]),
            campaign["agentplane_agent_id"],
        )
        results.append({
            "campaign_id": str(campaign["id"]),
            "result": result,
        })

    return {"campaigns_processed": len(results), "results": results}


async def main() -> dict[str, Any]:
    """Main executor entry point."""
    result = await process_scheduled_campaigns()
    logger.info("Campaign executor result: %s", result)
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

"""Email scheduler Lambda handler for batch campaign execution."""

import asyncio
import logging
import os
from typing import Any

from shared.agentplane_client import AgentPlaneClient
from shared.database import get_pool, get_transaction
from shared.queries import OutboxQueries
from shared.ses_client import SESClient

logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger(__name__)

BATCH_SIZE = 50
MAX_CONCURRENT_CALLS = 10


async def execute_campaign(
    campaign_id: str, org_id: str, tenant_id: str, agent_id: str
) -> dict[str, Any]:
    """Execute a campaign with batch processing and parallelization."""
    client = AgentPlaneClient(tenant_id=tenant_id, agent_id=agent_id)
    ses = SESClient()

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

        # Fetch targets
        targets = await conn.fetch(
            """
            SELECT t.*
            FROM targets t
            WHERE t.organization_id = $1 AND t.status = 'active'
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
                content = await client.generate_content(
                    dict(target),
                    "educational",
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

    # Bulk insert email sends
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
    return {"processed": len(results), "failed": failed_count}


async def process_scheduled_campaigns() -> dict[str, Any]:
    """Process all scheduled campaigns that are due."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Get scheduled campaigns (no RLS for this admin query)
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


async def send_queued_emails() -> dict[str, Any]:
    """Send emails that are queued and scheduled for now."""
    pool = await get_pool()
    ses = SESClient()

    async with pool.acquire() as conn:
        # Get queued emails ready to send with org domain settings
        sends = await conn.fetch(
            """
            SELECT es.*, o.email_domain, o.email_domain_verified, o.email_from_name,
                   o.ses_tenant_name, o.ses_configuration_set
            FROM email_sends es
            JOIN organizations o ON o.id = es.organization_id
            WHERE es.status = 'queued'
              AND (es.scheduled_at IS NULL OR es.scheduled_at <= NOW())
            ORDER BY es.created_at ASC
            LIMIT 100
            """
        )

    if not sends:
        logger.info("No queued emails to send")
    else:
        logger.info("Found %d queued email(s) to send", len(sends))

    sent_count = 0
    failed_count = 0

    for send in sends:
        # Build from_email if org has verified domain
        from_email = None
        if send["email_domain"] and send["email_domain_verified"]:
            from_name = send["email_from_name"] or "noreply"
            from_email = f"{from_name}@{send['email_domain']}"

        result = await ses.send_email(
            to_email=send["email"],
            subject=send["subject"],
            body_html=send["body"],
            from_email=from_email,
            configuration_set=send["ses_configuration_set"],
            tenant_name=send["ses_tenant_name"],
            unsubscribe_url=f"{os.environ.get('API_BASE_URL', 'https://api.envoy.app')}/unsubscribe/{send['target_id']}",
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
                # Update outbox status if linked
                if send.get("outbox_id"):
                    await OutboxQueries.mark_sent(
                        conn,
                        send["outbox_id"],
                        {"message_id": result["message_id"]},
                    )
                sent_count += 1
                logger.info("Sent email %s to %s (ses_id=%s)", send["id"], send["email"], result["message_id"])
            else:
                error_msg = f"{result.get('error_code')}: {result.get('error_message')}"
                logger.error("Email send failed: %s to %s - %s", send["id"], send["email"], error_msg)
                await conn.execute(
                    """
                    UPDATE email_sends SET status = 'failed' WHERE id = $1
                    """,
                    send["id"],
                )
                # Update outbox status if linked
                if send.get("outbox_id"):
                    await OutboxQueries.mark_failed(conn, send["outbox_id"], error_msg)
                failed_count += 1

    return {"sent": sent_count, "failed": failed_count}


async def main() -> dict[str, Any]:
    """Main scheduler entry point."""
    # Process scheduled campaigns
    campaign_result = await process_scheduled_campaigns()

    # Send queued emails
    email_result = await send_queued_emails()

    result = {
        "campaigns": campaign_result,
        "emails": email_result,
    }
    logger.info("Email scheduler result: %s", result)
    return result


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

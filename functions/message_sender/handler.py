"""Message sender Lambda handler for sending queued emails."""

import asyncio
from typing import Any

from shared.database import get_pool
from shared.queries import OutboxQueries
from shared.ses_client import SESClient

BATCH_SIZE = 100


async def send_queued_emails() -> dict[str, Any]:
    """Send emails that are queued and scheduled for now."""
    pool = await get_pool()
    ses = SESClient()

    async with pool.acquire() as conn:
        # Get queued emails ready to send with org domain settings
        sends = await conn.fetch(
            """
            SELECT es.*, o.email_domain, o.email_domain_verified, o.email_from_name
            FROM email_sends es
            JOIN organizations o ON o.id = es.organization_id
            WHERE es.status = 'queued'
              AND (es.scheduled_at IS NULL OR es.scheduled_at <= NOW())
            ORDER BY es.created_at ASC
            LIMIT $1
            """,
            BATCH_SIZE,
        )

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
            unsubscribe_url=f"https://api.envoy.app/unsubscribe/{send['target_id']}",
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
            else:
                error_msg = f"{result.get('error_code')}: {result.get('error_message')}"
                print(f"    Email failed: {send['email']} - {error_msg}")
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
    """Main sender entry point."""
    return await send_queued_emails()


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main())

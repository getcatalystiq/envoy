"""SES webhook handler for processing email events via SNS."""

import asyncio
import base64
import json
from typing import Any

import httpx
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding

from shared.database import get_pool


async def verify_sns_signature(message: dict) -> bool:
    """Verify SNS message signature."""
    if message.get("SignatureVersion") != "1":
        return False

    cert_url = message.get("SigningCertURL", "")
    if not cert_url.startswith("https://sns.") or ".amazonaws.com/" not in cert_url:
        return False

    # Fetch certificate
    async with httpx.AsyncClient() as client:
        response = await client.get(cert_url)
        cert = x509.load_pem_x509_certificate(response.content)

    # Build string to sign based on message type
    if message["Type"] == "Notification":
        fields = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
    else:
        fields = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"]

    string_to_sign = "".join(
        f"{field}\n{message.get(field, '')}\n"
        for field in fields
        if field in message
    )

    signature = base64.b64decode(message["Signature"])

    try:
        cert.public_key().verify(
            signature,
            string_to_sign.encode(),
            padding.PKCS1v15(),
            hashes.SHA1(),
        )
        return True
    except Exception:
        return False


async def update_send_status(ses_message_id: str, status: str, **extra_fields: Any) -> None:
    """Update email send status by SES message ID."""
    pool = await get_pool()

    set_clauses = [f"status = '{status}'"]
    for field, value in extra_fields.items():
        if value:
            set_clauses.append(f"{field} = '{value}'")

    async with pool.acquire() as conn:
        await conn.execute(
            f"""
            UPDATE email_sends
            SET {", ".join(set_clauses)}
            WHERE ses_message_id = $1
            """,
            ses_message_id,
        )


async def record_engagement_event(
    ses_message_id: str,
    event_type: str,
    occurred_at: str,
    metadata: dict | None = None,
) -> None:
    """Record an engagement event."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Get send record
        send = await conn.fetchrow(
            "SELECT id, organization_id FROM email_sends WHERE ses_message_id = $1",
            ses_message_id,
        )
        if not send:
            return

        await conn.execute(
            """
            INSERT INTO engagement_events (organization_id, send_id, event_type, occurred_at, metadata)
            VALUES ($1, $2, $3, $4, $5)
            """,
            send["organization_id"],
            send["id"],
            event_type,
            occurred_at,
            json.dumps(metadata or {}),
        )


async def update_target_status(email: str, status: str) -> None:
    """Update target status by email (for bounces/complaints)."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE targets
            SET status = $1, updated_at = NOW()
            WHERE email = $2 AND status = 'active'
            """,
            status,
            email,
        )


async def increment_soft_bounce(email: str) -> int:
    """Increment soft bounce count and return new count."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE email_sends
            SET soft_bounce_count = soft_bounce_count + 1
            WHERE email = $1 AND status NOT IN ('bounced', 'failed')
            RETURNING soft_bounce_count
            """,
            email,
        )
        return row["soft_bounce_count"] if row else 0


async def process_ses_event(event: dict) -> None:
    """Process SES event notification."""
    event_type = event.get("eventType")
    mail = event.get("mail", {})
    ses_message_id = mail.get("messageId")

    if not ses_message_id:
        return

    timestamp = event.get("timestamp", mail.get("timestamp"))

    if event_type == "Delivery":
        await update_send_status(ses_message_id, "delivered", delivered_at=timestamp)
        await record_engagement_event(ses_message_id, "delivered", timestamp)

    elif event_type == "Open":
        await update_send_status(ses_message_id, "opened", opened_at=timestamp)
        await record_engagement_event(ses_message_id, "opened", timestamp, event.get("open"))

    elif event_type == "Click":
        await update_send_status(ses_message_id, "clicked", clicked_at=timestamp)
        await record_engagement_event(ses_message_id, "clicked", timestamp, event.get("click"))

    elif event_type == "Bounce":
        bounce = event.get("bounce", {})
        bounce_type = bounce.get("bounceType")

        for recipient in bounce.get("bouncedRecipients", []):
            email = recipient.get("emailAddress")
            if not email:
                continue

            if bounce_type == "Permanent":
                # Hard bounce - immediately suppress
                await update_send_status(
                    ses_message_id, "bounced",
                    bounced_at=timestamp,
                    bounce_type="permanent",
                )
                await update_target_status(email, "bounced")
            else:
                # Soft bounce - track and suppress after threshold
                await update_send_status(
                    ses_message_id, "bounced",
                    bounced_at=timestamp,
                    bounce_type="soft",
                )
                count = await increment_soft_bounce(email)
                if count >= 3:
                    await update_target_status(email, "bounced")

        await record_engagement_event(ses_message_id, "bounced", timestamp, bounce)

    elif event_type == "Complaint":
        complaint = event.get("complaint", {})
        for recipient in complaint.get("complainedRecipients", []):
            email = recipient.get("emailAddress")
            if email:
                await update_target_status(email, "unsubscribed")

        await record_engagement_event(ses_message_id, "complained", timestamp, complaint)


async def handle_sns_event(record: dict) -> dict[str, str]:
    """Handle a single SNS record."""
    # Parse SNS message
    sns = record.get("Sns", {})
    message_body = sns.get("Message", "{}")

    try:
        message = json.loads(message_body)
    except json.JSONDecodeError:
        return {"status": "error", "detail": "Invalid JSON in message"}

    # Handle subscription confirmation
    if sns.get("Type") == "SubscriptionConfirmation":
        subscribe_url = message.get("SubscribeURL")
        if subscribe_url and subscribe_url.startswith("https://sns."):
            async with httpx.AsyncClient() as client:
                await client.get(subscribe_url)
        return {"status": "subscribed"}

    # Process SES event
    await process_ses_event(message)
    return {"status": "processed"}


async def main(event: dict) -> dict[str, Any]:
    """Main handler entry point."""
    records = event.get("Records", [])
    results = []

    for record in records:
        result = await handle_sns_event(record)
        results.append(result)

    return {"processed": len(results), "results": results}


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    """Lambda entry point."""
    return asyncio.get_event_loop().run_until_complete(main(event))

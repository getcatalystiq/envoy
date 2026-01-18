"""Send router for email distribution."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import SendRequest, SendResponse
from shared.email_wrapper import wrap_email_body
from shared.queries import ContentQueries, TargetQueries
from shared.ses_client import SESClient

router = APIRouter()


@router.post("", response_model=SendResponse)
async def send_email(
    data: SendRequest,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SendResponse:
    """Send content to a target."""
    # Get target
    target = await TargetQueries.get_by_id(db, data.target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")

    if target["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail=f"Cannot send to target with status: {target['status']}",
        )

    # Get content or use provided subject/body
    subject = data.subject
    body = data.body

    if data.content_id:
        content = await ContentQueries.get_by_id(db, data.content_id)
        if not content:
            raise HTTPException(status_code=404, detail="Content not found")
        subject = subject or content["subject"]
        body = body or content["body"]

    if not subject or not body:
        raise HTTPException(
            status_code=400,
            detail="Subject and body are required",
        )

    # Wrap email body in standard layout
    body = wrap_email_body(body)

    # Create email send record
    send_id = await db.fetchval(
        """
        INSERT INTO email_sends (
            organization_id, campaign_id, target_id, content_id,
            email, subject, body, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
        RETURNING id
        """,
        org_id,
        data.campaign_id,
        data.target_id,
        data.content_id,
        target["email"],
        subject,
        body,
    )

    # Get org email domain settings
    org = await db.fetchrow(
        "SELECT email_domain, email_domain_verified, email_from_name FROM organizations WHERE id = $1",
        org_id,
    )

    # Build from_email if org has verified domain
    from_email = None
    if org and org["email_domain"] and org["email_domain_verified"]:
        from_name = org["email_from_name"] or "noreply"
        from_email = f"{from_name}@{org['email_domain']}"

    # Send via SES
    ses = SESClient()
    result = await ses.send_email(
        to_email=target["email"],
        subject=subject,
        body_html=body,
        from_email=from_email,
        unsubscribe_url=f"{os.environ.get('API_BASE_URL', 'https://api.envoy.app')}/unsubscribe/{data.target_id}",
    )

    # Update send record
    if result["success"]:
        await db.execute(
            """
            UPDATE email_sends
            SET status = 'sent', ses_message_id = $1, sent_at = NOW()
            WHERE id = $2
            """,
            result["message_id"],
            send_id,
        )
        return SendResponse(
            id=send_id,
            email=target["email"],
            status="sent",
            ses_message_id=result["message_id"],
            sent_at=None,  # Will be populated from DB in real response
        )
    else:
        await db.execute(
            """
            UPDATE email_sends
            SET status = 'failed'
            WHERE id = $1
            """,
            send_id,
        )
        raise HTTPException(
            status_code=500,
            detail=f"Failed to send email: {result.get('error_message')}",
        )


@router.get("/{send_id}", response_model=SendResponse)
async def get_send_status(
    send_id: UUID,
    db: DBConnection,
) -> SendResponse:
    """Get status of an email send."""
    row = await db.fetchrow(
        "SELECT id, email, status, ses_message_id, sent_at FROM email_sends WHERE id = $1",
        send_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Send not found")

    return SendResponse(**dict(row))

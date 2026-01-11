"""Outbox router for human-in-the-loop approval queue."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.dependencies import CurrentOrg, CurrentUser, DBConnection
from app.schemas import (
    ListResponse,
    OutboxCreate,
    OutboxReject,
    OutboxResponse,
    OutboxSnooze,
    OutboxStats,
    OutboxUpdate,
    OutboxWithTarget,
)
from shared.queries import OutboxQueries

router = APIRouter()


@router.post("", response_model=OutboxResponse, status_code=201)
async def create_outbox_item(
    data: OutboxCreate,
    org_id: CurrentOrg,
    user: CurrentUser,
    db: DBConnection,
) -> OutboxResponse:
    """Create a new outbox item for human review."""
    item = await OutboxQueries.create(
        db,
        org_id=org_id,
        target_id=data.target_id,
        channel=data.channel,
        subject=data.subject,
        body=data.body,
        skill_name=data.skill_name,
        skill_reasoning=data.skill_reasoning,
        confidence_score=data.confidence_score,
        priority=data.priority,
        scheduled_for=data.scheduled_for.isoformat() if data.scheduled_for else None,
        created_by=UUID(user["sub"]) if user.get("sub") else None,
    )
    return OutboxResponse(**item)


@router.get("", response_model=ListResponse)
async def list_outbox(
    org_id: CurrentOrg,
    db: DBConnection,
    status: Optional[str] = Query(None, pattern="^(pending|approved|rejected|snoozed|sent|failed)$"),
    channel: Optional[str] = Query(None, pattern="^(email|linkedin|sms)$"),
    target_id: Optional[UUID] = None,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List outbox items with optional filters."""
    items = await OutboxQueries.list(
        db,
        org_id=org_id,
        status=status,
        channel=channel,
        target_id=target_id,
        limit=limit,
        offset=offset,
    )
    total = await OutboxQueries.count(db, org_id, status)

    return ListResponse(
        items=[OutboxResponse(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/pending", response_model=ListResponse)
async def list_pending_outbox(
    org_id: CurrentOrg,
    db: DBConnection,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List pending outbox items with target details."""
    items = await OutboxQueries.list_pending(db, org_id, limit, offset)
    total = await OutboxQueries.count(db, org_id, "pending")

    return ListResponse(
        items=[OutboxWithTarget(**item) for item in items],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/stats", response_model=OutboxStats)
async def get_outbox_stats(
    org_id: CurrentOrg,
    db: DBConnection,
) -> OutboxStats:
    """Get outbox statistics by status."""
    stats = await OutboxQueries.get_stats(db, org_id)
    return OutboxStats(**stats)


@router.get("/{outbox_id}", response_model=OutboxResponse)
async def get_outbox_item(
    outbox_id: UUID,
    db: DBConnection,
) -> OutboxResponse:
    """Get outbox item by ID."""
    item = await OutboxQueries.get_by_id(db, outbox_id)
    if not item:
        raise HTTPException(status_code=404, detail="Outbox item not found")
    return OutboxResponse(**item)


@router.patch("/{outbox_id}", response_model=OutboxResponse)
async def update_outbox_item(
    outbox_id: UUID,
    data: OutboxUpdate,
    user: CurrentUser,
    db: DBConnection,
) -> OutboxResponse:
    """Update an outbox item (subject, body, priority, scheduled_for)."""
    existing = await OutboxQueries.get_by_id(db, outbox_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Outbox item not found")

    if existing["status"] not in ("pending", "snoozed"):
        raise HTTPException(status_code=400, detail="Can only edit pending or snoozed items")

    update_data = data.model_dump(exclude_unset=True)

    # Track edits for audit trail
    user_id = UUID(user["sub"]) if user.get("sub") else None
    if user_id:
        if "subject" in update_data and update_data["subject"] != existing.get("subject"):
            await OutboxQueries.add_edit(
                db, outbox_id, user_id, "subject",
                existing.get("subject") or "", update_data["subject"] or ""
            )
        if "body" in update_data and update_data["body"] != existing.get("body"):
            await OutboxQueries.add_edit(
                db, outbox_id, user_id, "body",
                existing.get("body") or "", update_data["body"] or ""
            )

    if "scheduled_for" in update_data and update_data["scheduled_for"]:
        update_data["scheduled_for"] = update_data["scheduled_for"].isoformat()

    item = await OutboxQueries.update(db, outbox_id, **update_data)
    return OutboxResponse(**item)


@router.post("/{outbox_id}/approve", response_model=OutboxResponse)
async def approve_outbox_item(
    outbox_id: UUID,
    user: CurrentUser,
    db: DBConnection,
) -> OutboxResponse:
    """Approve an outbox item for sending."""
    existing = await OutboxQueries.get_by_id(db, outbox_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Outbox item not found")

    if existing["status"] != "pending":
        raise HTTPException(status_code=400, detail="Can only approve pending items")

    user_id = UUID(user["sub"]) if user.get("sub") else None
    item = await OutboxQueries.approve(db, outbox_id, user_id)
    if not item:
        raise HTTPException(status_code=400, detail="Failed to approve item")

    return OutboxResponse(**item)


@router.post("/{outbox_id}/reject", response_model=OutboxResponse)
async def reject_outbox_item(
    outbox_id: UUID,
    data: OutboxReject,
    user: CurrentUser,
    db: DBConnection,
) -> OutboxResponse:
    """Reject an outbox item."""
    existing = await OutboxQueries.get_by_id(db, outbox_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Outbox item not found")

    if existing["status"] != "pending":
        raise HTTPException(status_code=400, detail="Can only reject pending items")

    user_id = UUID(user["sub"]) if user.get("sub") else None
    item = await OutboxQueries.reject(db, outbox_id, data.reason, user_id)
    if not item:
        raise HTTPException(status_code=400, detail="Failed to reject item")

    return OutboxResponse(**item)


@router.post("/{outbox_id}/snooze", response_model=OutboxResponse)
async def snooze_outbox_item(
    outbox_id: UUID,
    data: OutboxSnooze,
    user: CurrentUser,
    db: DBConnection,
) -> OutboxResponse:
    """Snooze an outbox item until a specific time."""
    existing = await OutboxQueries.get_by_id(db, outbox_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Outbox item not found")

    if existing["status"] != "pending":
        raise HTTPException(status_code=400, detail="Can only snooze pending items")

    user_id = UUID(user["sub"]) if user.get("sub") else None
    item = await OutboxQueries.snooze(
        db, outbox_id, data.snooze_until.isoformat(), user_id
    )
    if not item:
        raise HTTPException(status_code=400, detail="Failed to snooze item")

    return OutboxResponse(**item)


@router.delete("/{outbox_id}", status_code=204)
async def delete_outbox_item(
    outbox_id: UUID,
    db: DBConnection,
) -> None:
    """Delete an outbox item."""
    existing = await OutboxQueries.get_by_id(db, outbox_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Outbox item not found")

    if existing["status"] in ("sent", "approved"):
        raise HTTPException(status_code=400, detail="Cannot delete sent or approved items")

    deleted = await OutboxQueries.delete(db, outbox_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Outbox item not found")


@router.post("/bulk/approve", response_model=dict)
async def bulk_approve_outbox(
    outbox_ids: list[UUID],
    user: CurrentUser,
    db: DBConnection,
) -> dict:
    """Bulk approve multiple outbox items."""
    user_id = UUID(user["sub"]) if user.get("sub") else None
    approved = 0
    errors = []

    for outbox_id in outbox_ids:
        try:
            item = await OutboxQueries.approve(db, outbox_id, user_id)
            if item:
                approved += 1
            else:
                errors.append({"id": str(outbox_id), "error": "Item not pending"})
        except Exception as e:
            errors.append({"id": str(outbox_id), "error": str(e)})

    return {"approved": approved, "errors": errors}


@router.post("/bulk/reject", response_model=dict)
async def bulk_reject_outbox(
    data: dict,
    user: CurrentUser,
    db: DBConnection,
) -> dict:
    """Bulk reject multiple outbox items."""
    outbox_ids = data.get("outbox_ids", [])
    reason = data.get("reason")
    user_id = UUID(user["sub"]) if user.get("sub") else None
    rejected = 0
    errors = []

    for outbox_id in outbox_ids:
        try:
            item = await OutboxQueries.reject(db, UUID(outbox_id), reason, user_id)
            if item:
                rejected += 1
            else:
                errors.append({"id": str(outbox_id), "error": "Item not pending"})
        except Exception as e:
            errors.append({"id": str(outbox_id), "error": str(e)})

    return {"rejected": rejected, "errors": errors}

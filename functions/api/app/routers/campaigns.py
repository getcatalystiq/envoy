"""Campaigns router."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import CampaignCreate, CampaignResponse, CampaignUpdate, ListResponse
from shared.queries import CampaignQueries

router = APIRouter()


@router.post("", response_model=CampaignResponse, status_code=201)
async def create_campaign(
    data: CampaignCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> CampaignResponse:
    """Create a new campaign."""
    campaign = await CampaignQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        target_criteria=data.target_criteria,
        skills=data.skills,
        scheduled_at=data.scheduled_at.isoformat() if data.scheduled_at else None,
        settings=data.settings,
    )
    return CampaignResponse(**campaign)


@router.get("", response_model=ListResponse)
async def list_campaigns(
    org_id: CurrentOrg,
    db: DBConnection,
    status: Optional[str] = Query(None, pattern="^(draft|scheduled|active|paused|completed)$"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List campaigns with optional status filter."""
    campaigns = await CampaignQueries.list(
        db,
        org_id=org_id,
        status=status,
        limit=limit,
        offset=offset,
    )

    return ListResponse(
        items=[CampaignResponse(**c) for c in campaigns],
        total=len(campaigns),
        limit=limit,
        offset=offset,
    )


@router.get("/{campaign_id}", response_model=CampaignResponse)
async def get_campaign(
    campaign_id: UUID,
    db: DBConnection,
) -> CampaignResponse:
    """Get a campaign by ID."""
    campaign = await CampaignQueries.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")
    return CampaignResponse(**campaign)


@router.patch("/{campaign_id}", response_model=CampaignResponse)
async def update_campaign(
    campaign_id: UUID,
    data: CampaignUpdate,
    db: DBConnection,
) -> CampaignResponse:
    """Update a campaign."""
    existing = await CampaignQueries.get_by_id(db, campaign_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Can't update active/completed campaigns
    if existing["status"] in ("active", "completed"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot update campaign in {existing['status']} status",
        )

    update_data = data.model_dump(exclude_unset=True)
    if "scheduled_at" in update_data and update_data["scheduled_at"]:
        update_data["scheduled_at"] = update_data["scheduled_at"].isoformat()

    campaign = await CampaignQueries.update(db, campaign_id, **update_data)
    return CampaignResponse(**campaign)


@router.delete("/{campaign_id}", status_code=204)
async def delete_campaign(
    campaign_id: UUID,
    db: DBConnection,
) -> None:
    """Delete a campaign."""
    existing = await CampaignQueries.get_by_id(db, campaign_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Campaign not found")

    if existing["status"] in ("active", "completed"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot delete campaign in {existing['status']} status",
        )

    await CampaignQueries.delete(db, campaign_id)


@router.post("/{campaign_id}/content/{content_id}", status_code=201)
async def add_campaign_content(
    campaign_id: UUID,
    content_id: UUID,
    db: DBConnection,
    position: int = Query(0, ge=0),
) -> dict[str, str]:
    """Add content to a campaign."""
    campaign = await CampaignQueries.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    success = await CampaignQueries.add_content(db, campaign_id, content_id, position)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to add content")

    return {"status": "added"}


@router.delete("/{campaign_id}/content/{content_id}", status_code=204)
async def remove_campaign_content(
    campaign_id: UUID,
    content_id: UUID,
    db: DBConnection,
) -> None:
    """Remove content from a campaign."""
    removed = await CampaignQueries.remove_content(db, campaign_id, content_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Content not found in campaign")


@router.post("/{campaign_id}/start", response_model=CampaignResponse)
async def start_campaign(
    campaign_id: UUID,
    db: DBConnection,
) -> CampaignResponse:
    """Start a campaign."""
    campaign = await CampaignQueries.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    if campaign["status"] not in ("draft", "scheduled", "paused"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot start campaign in {campaign['status']} status",
        )

    updated = await CampaignQueries.update_status(
        db,
        campaign_id,
        status="active",
        started_at="NOW()",
    )
    return CampaignResponse(**updated)


@router.post("/{campaign_id}/pause", response_model=CampaignResponse)
async def pause_campaign(
    campaign_id: UUID,
    db: DBConnection,
) -> CampaignResponse:
    """Pause an active campaign."""
    campaign = await CampaignQueries.get_by_id(db, campaign_id)
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    if campaign["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail="Can only pause active campaigns",
        )

    updated = await CampaignQueries.update_status(db, campaign_id, status="paused")
    return CampaignResponse(**updated)

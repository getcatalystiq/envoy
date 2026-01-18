"""Targets router."""

from typing import Optional
from uuid import UUID
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import ListResponse, TargetCreate, TargetResponse, TargetUpdate
from shared.queries import TargetQueries
from shared.queries.targets import auto_enroll_in_default_sequence

router = APIRouter()


class TargetTypeResponse(BaseModel):
    """Schema for target type response."""

    id: UUID
    name: str
    description: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class SegmentResponse(BaseModel):
    """Schema for segment response."""

    id: UUID
    name: str
    description: Optional[str] = None
    created_at: datetime

    model_config = {"from_attributes": True}


@router.get("/types", response_model=list[TargetTypeResponse])
async def list_target_types(
    org_id: CurrentOrg,
    db: DBConnection,
) -> list[TargetTypeResponse]:
    """List all target types for the organization."""
    rows = await db.fetch(
        """
        SELECT id, name, description, created_at
        FROM target_types
        WHERE organization_id = $1
        ORDER BY name ASC
        """,
        org_id,
    )
    return [TargetTypeResponse(**dict(row)) for row in rows]


@router.get("/segments", response_model=list[SegmentResponse])
async def list_segments(
    org_id: CurrentOrg,
    db: DBConnection,
) -> list[SegmentResponse]:
    """List all segments for the organization."""
    rows = await db.fetch(
        """
        SELECT id, name, description, created_at
        FROM segments
        WHERE organization_id = $1
        ORDER BY name ASC
        """,
        org_id,
    )
    return [SegmentResponse(**dict(row)) for row in rows]


@router.post("", response_model=TargetResponse, status_code=201)
async def create_target(
    data: TargetCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> TargetResponse:
    """Create a new target."""
    # Check if email already exists
    existing = await TargetQueries.get_by_email(db, org_id, data.email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already exists")

    target = await TargetQueries.create(
        db,
        org_id=org_id,
        email=data.email,
        first_name=data.first_name,
        last_name=data.last_name,
        company=data.company,
        target_type_id=data.target_type_id,
        segment_id=data.segment_id,
        lifecycle_stage=data.lifecycle_stage,
        custom_fields=data.custom_fields,
    )

    # Auto-enroll in default sequence if target type is set
    if data.target_type_id:
        await auto_enroll_in_default_sequence(
            db, org_id, target["id"], data.target_type_id
        )

    return TargetResponse(**target)


@router.get("", response_model=ListResponse)
async def list_targets(
    org_id: CurrentOrg,
    db: DBConnection,
    status: Optional[str] = Query(None, pattern="^(active|unsubscribed|bounced)$"),
    target_type_id: Optional[UUID] = None,
    segment_id: Optional[UUID] = None,
    lifecycle_stage: Optional[int] = Query(None, ge=0, le=6),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List targets with optional filters."""
    targets = await TargetQueries.list(
        db,
        org_id=org_id,
        status=status,
        target_type_id=target_type_id,
        segment_id=segment_id,
        lifecycle_stage=lifecycle_stage,
        limit=limit,
        offset=offset,
    )
    total = await TargetQueries.count(db, org_id, status)

    return ListResponse(
        items=[TargetResponse(**t) for t in targets],
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/{target_id}", response_model=TargetResponse)
async def get_target(
    target_id: UUID,
    db: DBConnection,
) -> TargetResponse:
    """Get a target by ID."""
    target = await TargetQueries.get_by_id(db, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    return TargetResponse(**target)


@router.patch("/{target_id}", response_model=TargetResponse)
async def update_target(
    target_id: UUID,
    data: TargetUpdate,
    db: DBConnection,
) -> TargetResponse:
    """Update a target."""
    # Check target exists
    existing = await TargetQueries.get_by_id(db, target_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Target not found")

    update_data = data.model_dump(exclude_unset=True)
    target = await TargetQueries.update(db, target_id, **update_data)
    return TargetResponse(**target)


@router.delete("/{target_id}", status_code=204)
async def delete_target(
    target_id: UUID,
    db: DBConnection,
) -> None:
    """Delete a target."""
    deleted = await TargetQueries.delete(db, target_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Target not found")

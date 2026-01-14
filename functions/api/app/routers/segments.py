"""Segments API routes."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    SegmentCreate,
    SegmentResponse,
    SegmentUpdate,
    SegmentUsageCount,
)
from shared.queries.segments import SegmentQueries
from shared.queries.target_types import TargetTypeQueries

router = APIRouter()


@router.get("", response_model=list[SegmentResponse])
async def list_segments(
    org_id: CurrentOrg,
    db: DBConnection,
    target_type_id: Optional[UUID] = None,
) -> list[SegmentResponse]:
    """List all segments, optionally filtered by target type."""
    segments = await SegmentQueries.list(db, org_id, target_type_id)
    return [SegmentResponse(**s) for s in segments]


@router.post("", response_model=SegmentResponse, status_code=201)
async def create_segment(
    data: SegmentCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SegmentResponse:
    """Create a new segment."""
    # Verify target type exists and belongs to org
    target_type = await TargetTypeQueries.get(db, data.target_type_id, org_id)
    if not target_type:
        raise HTTPException(400, "Target type not found")

    # Check for duplicate name within target type
    existing = await SegmentQueries.get_by_name(db, data.target_type_id, data.name)
    if existing:
        raise HTTPException(
            400,
            f"Segment with name '{data.name}' already exists for this target type",
        )

    segment = await SegmentQueries.create(
        db,
        org_id=org_id,
        target_type_id=data.target_type_id,
        name=data.name,
        description=data.description,
        pain_points=data.pain_points,
        objections=data.objections,
    )
    return SegmentResponse(**segment)


@router.get("/{segment_id}", response_model=SegmentResponse)
async def get_segment(
    segment_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SegmentResponse:
    """Get a specific segment."""
    segment = await SegmentQueries.get(db, segment_id, org_id)
    if not segment:
        raise HTTPException(404, "Segment not found")
    return SegmentResponse(**segment)


@router.get("/{segment_id}/usage", response_model=SegmentUsageCount)
async def get_segment_usage(
    segment_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SegmentUsageCount:
    """Get usage counts for a segment."""
    # First verify the segment exists and belongs to org
    segment = await SegmentQueries.get(db, segment_id, org_id)
    if not segment:
        raise HTTPException(404, "Segment not found")

    usage = await SegmentQueries.get_usage_count(db, segment_id)
    return SegmentUsageCount(**usage)


@router.patch("/{segment_id}", response_model=SegmentResponse)
async def update_segment(
    segment_id: UUID,
    data: SegmentUpdate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SegmentResponse:
    """Update a segment."""
    # Get current segment
    current = await SegmentQueries.get(db, segment_id, org_id)
    if not current:
        raise HTTPException(404, "Segment not found")

    # If changing target type, verify new type exists
    target_type_id = data.target_type_id or current["target_type_id"]
    if data.target_type_id:
        target_type = await TargetTypeQueries.get(db, data.target_type_id, org_id)
        if not target_type:
            raise HTTPException(400, "Target type not found")

    # Check for duplicate name if changing name or target type
    if data.name or data.target_type_id:
        name_to_check = data.name or current["name"]
        existing = await SegmentQueries.get_by_name(db, target_type_id, name_to_check)
        if existing and existing["id"] != segment_id:
            raise HTTPException(
                400,
                f"Segment with name '{name_to_check}' already exists for this target type",
            )

    segment = await SegmentQueries.update(
        db,
        segment_id=segment_id,
        org_id=org_id,
        name=data.name,
        description=data.description,
        target_type_id=data.target_type_id,
        pain_points=data.pain_points,
        objections=data.objections,
    )
    if not segment:
        raise HTTPException(404, "Segment not found")
    return SegmentResponse(**segment)


@router.delete("/{segment_id}", status_code=204)
async def delete_segment(
    segment_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> None:
    """Delete a segment.

    Note: Deleting will SET NULL on targets and content referencing this segment.
    """
    # First verify it exists
    segment = await SegmentQueries.get(db, segment_id, org_id)
    if not segment:
        raise HTTPException(404, "Segment not found")

    deleted = await SegmentQueries.delete(db, segment_id, org_id)
    if not deleted:
        raise HTTPException(404, "Segment not found")

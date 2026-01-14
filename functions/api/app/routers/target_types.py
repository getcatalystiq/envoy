"""Target types API routes."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    TargetTypeCreate,
    TargetTypeResponse,
    TargetTypeUpdate,
    TargetTypeUsageCount,
)
from shared.queries.target_types import TargetTypeQueries

router = APIRouter()


@router.get("", response_model=list[TargetTypeResponse])
async def list_target_types(
    org_id: CurrentOrg,
    db: DBConnection,
) -> list[TargetTypeResponse]:
    """List all target types for the organization."""
    types = await TargetTypeQueries.list(db, org_id)
    return [TargetTypeResponse(**t) for t in types]


@router.post("", response_model=TargetTypeResponse, status_code=201)
async def create_target_type(
    data: TargetTypeCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> TargetTypeResponse:
    """Create a new target type."""
    # Check for duplicate name
    existing = await TargetTypeQueries.get_by_name(db, org_id, data.name)
    if existing:
        raise HTTPException(400, f"Target type with name '{data.name}' already exists")

    target_type = await TargetTypeQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        description=data.description,
    )
    return TargetTypeResponse(**target_type)


@router.get("/{type_id}", response_model=TargetTypeResponse)
async def get_target_type(
    type_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> TargetTypeResponse:
    """Get a specific target type."""
    target_type = await TargetTypeQueries.get(db, type_id, org_id)
    if not target_type:
        raise HTTPException(404, "Target type not found")
    return TargetTypeResponse(**target_type)


@router.get("/{type_id}/usage", response_model=TargetTypeUsageCount)
async def get_target_type_usage(
    type_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> TargetTypeUsageCount:
    """Get usage counts for a target type."""
    # First verify the target type exists and belongs to org
    target_type = await TargetTypeQueries.get(db, type_id, org_id)
    if not target_type:
        raise HTTPException(404, "Target type not found")

    usage = await TargetTypeQueries.get_usage_count(db, type_id)
    return TargetTypeUsageCount(**usage)


@router.patch("/{type_id}", response_model=TargetTypeResponse)
async def update_target_type(
    type_id: UUID,
    data: TargetTypeUpdate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> TargetTypeResponse:
    """Update a target type."""
    # Check for duplicate name if changing name
    if data.name:
        existing = await TargetTypeQueries.get_by_name(db, org_id, data.name)
        if existing and existing["id"] != type_id:
            raise HTTPException(400, f"Target type with name '{data.name}' already exists")

    target_type = await TargetTypeQueries.update(
        db,
        type_id=type_id,
        org_id=org_id,
        name=data.name,
        description=data.description,
    )
    if not target_type:
        raise HTTPException(404, "Target type not found")
    return TargetTypeResponse(**target_type)


@router.delete("/{type_id}", status_code=204)
async def delete_target_type(
    type_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> None:
    """Delete a target type.

    Note: Deleting will:
    - CASCADE delete all segments under this type
    - SET NULL on targets referencing this type
    - SET NULL on content referencing this type
    - RESTRICT if any sequences reference this type (blocked)
    """
    # First verify it exists
    target_type = await TargetTypeQueries.get(db, type_id, org_id)
    if not target_type:
        raise HTTPException(404, "Target type not found")

    # Check usage
    usage = await TargetTypeQueries.get_usage_count(db, type_id)

    # Block deletion if sequences exist (RESTRICT constraint)
    if usage.get("sequences", 0) > 0:
        raise HTTPException(
            400,
            f"Cannot delete: {usage['sequences']} sequence(s) use this target type. "
            "Delete or reassign sequences first.",
        )

    deleted = await TargetTypeQueries.delete(db, type_id, org_id)
    if not deleted:
        raise HTTPException(404, "Target type not found")

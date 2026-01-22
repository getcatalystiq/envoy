"""Graduation rules API endpoints."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, status

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    GraduationEventResponse,
    GraduationRuleCreate,
    GraduationRuleResponse,
    GraduationRuleUpdate,
)
from shared.queries.graduation import GraduationQueries

router = APIRouter()


@router.get("", response_model=list[GraduationRuleResponse])
async def list_graduation_rules(
    org_id: CurrentOrg,
    db: DBConnection,
    source_target_type_id: Optional[UUID] = None,
    enabled: Optional[bool] = None,
) -> list[GraduationRuleResponse]:
    """List graduation rules for the organization."""
    rules = await GraduationQueries.list_rules(
        db, org_id, source_target_type_id=source_target_type_id, enabled=enabled
    )
    return [GraduationRuleResponse(**r) for r in rules]


@router.get("/events", response_model=list[GraduationEventResponse])
async def list_graduation_events(
    org_id: CurrentOrg,
    db: DBConnection,
    limit: int = 50,
    offset: int = 0,
) -> list[GraduationEventResponse]:
    """List graduation events for the organization."""
    events = await GraduationQueries.list_graduation_events(
        db, org_id, limit=limit, offset=offset
    )
    return [GraduationEventResponse(**e) for e in events]


@router.post(
    "", response_model=GraduationRuleResponse, status_code=status.HTTP_201_CREATED
)
async def create_graduation_rule(
    data: GraduationRuleCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> GraduationRuleResponse:
    """Create a new graduation rule."""
    # Validate source != destination
    if data.source_target_type_id == data.destination_target_type_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source and destination target types must be different",
        )

    # Validate both target types belong to organization
    source_type = await db.fetchrow(
        "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
        data.source_target_type_id,
        org_id,
    )
    if not source_type:
        raise HTTPException(status_code=400, detail="Invalid source target type")

    dest_type = await db.fetchrow(
        "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
        data.destination_target_type_id,
        org_id,
    )
    if not dest_type:
        raise HTTPException(status_code=400, detail="Invalid destination target type")

    # Check for cycles (app-level, not DB trigger)
    if data.enabled:
        has_cycle = await GraduationQueries.check_for_cycle(
            db, org_id, data.source_target_type_id, data.destination_target_type_id
        )
        if has_cycle:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This rule would create a circular graduation path",
            )

    rule = await GraduationQueries.create_rule(
        db,
        org_id=org_id,
        source_target_type_id=data.source_target_type_id,
        destination_target_type_id=data.destination_target_type_id,
        name=data.name,
        description=data.description,
        conditions=[c.model_dump() for c in data.conditions],
        enabled=data.enabled,
    )
    return GraduationRuleResponse(**rule)


@router.get("/{rule_id}", response_model=GraduationRuleResponse)
async def get_graduation_rule(
    rule_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> GraduationRuleResponse:
    """Get a graduation rule by ID."""
    rule = await GraduationQueries.get_rule(db, org_id, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Graduation rule not found")
    return GraduationRuleResponse(**rule)


@router.patch("/{rule_id}", response_model=GraduationRuleResponse)
async def update_graduation_rule(
    rule_id: UUID,
    data: GraduationRuleUpdate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> GraduationRuleResponse:
    """Update a graduation rule."""
    existing = await GraduationQueries.get_rule(db, org_id, rule_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Graduation rule not found")

    update_data = data.model_dump(exclude_unset=True)
    if "conditions" in update_data and data.conditions:
        update_data["conditions"] = [c.model_dump() for c in data.conditions]

    # Check for cycles if enabling
    if update_data.get("enabled", existing["enabled"]):
        has_cycle = await GraduationQueries.check_for_cycle(
            db,
            org_id,
            existing["source_target_type_id"],
            existing["destination_target_type_id"],
            exclude_rule_id=rule_id,
        )
        if has_cycle:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Enabling this rule would create a circular graduation path",
            )

    rule = await GraduationQueries.update_rule(db, org_id, rule_id, **update_data)
    return GraduationRuleResponse(**rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_graduation_rule(
    rule_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> None:
    """Delete a graduation rule."""
    deleted = await GraduationQueries.delete_rule(db, org_id, rule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Graduation rule not found")

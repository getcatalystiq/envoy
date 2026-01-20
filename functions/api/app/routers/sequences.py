"""Sequences router."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    EnrollmentCreate,
    EnrollmentResponse,
    ListResponse,
    SequenceCreate,
    SequenceResponse,
    SequenceStepCreate,
    SequenceStepUpdate,
    SequenceUpdate,
    StepExecutionResponse,
)
from shared.queries import SequenceQueries

router = APIRouter()


# =============================================================================
# SEQUENCES
# =============================================================================


@router.post("", response_model=SequenceResponse, status_code=201)
async def create_sequence(
    data: SequenceCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SequenceResponse:
    """Create a new sequence."""
    sequence = await SequenceQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        target_type_id=data.target_type_id,
        status=data.status,
    )
    return SequenceResponse(**sequence, steps=[])


@router.get("", response_model=ListResponse)
async def list_sequences(
    org_id: CurrentOrg,
    db: DBConnection,
    status: Optional[str] = Query(None, pattern="^(draft|active|paused|archived)$"),
    target_type_id: Optional[UUID] = None,
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List sequences with optional filters."""
    sequences = await SequenceQueries.list(
        db,
        org_id=org_id,
        status=status,
        target_type_id=target_type_id,
        limit=limit,
        offset=offset,
    )

    return ListResponse(
        items=[SequenceResponse(**s) for s in sequences],
        total=len(sequences),
        limit=limit,
        offset=offset,
    )


@router.get("/{sequence_id}", response_model=SequenceResponse)
async def get_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Get a sequence by ID with steps."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")
    return SequenceResponse(**sequence)


@router.patch("/{sequence_id}", response_model=SequenceResponse)
async def update_sequence(
    sequence_id: UUID,
    data: SequenceUpdate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SequenceResponse:
    """Update a sequence."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    update_data = data.model_dump(exclude_unset=True)

    # Handle is_default: ensure only one default per target_type
    if update_data.get("is_default") is True:
        target_type_id = update_data.get("target_type_id", existing.get("target_type_id"))
        if not target_type_id:
            raise HTTPException(
                status_code=400,
                detail="Cannot set as default - sequence has no target type",
            )
        if existing["status"] != "active":
            raise HTTPException(
                status_code=400,
                detail="Only active sequences can be set as default",
            )
        # Unset any existing default for this target type
        await SequenceQueries.unset_default_for_target_type(db, org_id, target_type_id)

    sequence = await SequenceQueries.update(db, sequence_id, **update_data)

    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.delete("/{sequence_id}", status_code=204)
async def delete_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> None:
    """Delete a sequence."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if existing["status"] == "active":
        raise HTTPException(
            status_code=400,
            detail="Cannot delete active sequence. Archive it first.",
        )

    await SequenceQueries.delete(db, sequence_id)


@router.post("/{sequence_id}/activate", response_model=SequenceResponse)
async def activate_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Activate a draft or paused sequence."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if existing["status"] not in ("draft", "paused"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot activate sequence in {existing['status']} status",
        )

    # Verify sequence has at least one step
    steps = await SequenceQueries.list_steps(db, sequence_id)
    if not steps:
        raise HTTPException(
            status_code=400,
            detail="Cannot activate sequence without steps",
        )

    sequence = await SequenceQueries.update(db, sequence_id, status="active")

    # Activate all paused enrollments in this sequence
    await SequenceQueries.resume_all_enrollments(db, sequence_id)

    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.post("/{sequence_id}/archive", response_model=SequenceResponse)
async def archive_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Archive a sequence."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    sequence = await SequenceQueries.update(db, sequence_id, status="archived")
    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.post("/{sequence_id}/pause", response_model=SequenceResponse)
async def pause_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Pause an active sequence to allow editing (sets status to draft)."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if existing["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail="Only active sequences can be paused",
        )

    # Update sequence status to draft (allows editing)
    sequence = await SequenceQueries.update(db, sequence_id, status="draft")

    # Pause all active enrollments in this sequence
    await SequenceQueries.pause_all_enrollments(db, sequence_id)

    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.post("/{sequence_id}/resume", response_model=SequenceResponse)
async def resume_sequence(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Resume a paused sequence (reactivate from draft)."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if existing["status"] != "draft":
        raise HTTPException(
            status_code=400,
            detail="Only draft sequences can be resumed",
        )

    # Verify sequence has at least one step
    steps = await SequenceQueries.list_steps(db, sequence_id)
    if not steps:
        raise HTTPException(
            status_code=400,
            detail="Cannot activate sequence without steps",
        )

    # Update sequence status to active
    sequence = await SequenceQueries.update(db, sequence_id, status="active")

    # Resume all paused enrollments in this sequence
    await SequenceQueries.resume_all_enrollments(db, sequence_id)

    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.post("/{sequence_id}/set-default", response_model=SequenceResponse)
async def set_sequence_as_default(
    sequence_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> SequenceResponse:
    """Set a sequence as the default for its target type."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if not existing.get("target_type_id"):
        raise HTTPException(
            status_code=400,
            detail="Cannot set as default - sequence has no target type",
        )

    if existing["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail="Only active sequences can be set as default",
        )

    # Unset any existing default, then set this one
    await SequenceQueries.unset_default_for_target_type(
        db, org_id, existing["target_type_id"]
    )

    sequence = await SequenceQueries.update(db, sequence_id, is_default=True)
    return SequenceResponse(**sequence, steps=existing.get("steps", []))


@router.delete("/{sequence_id}/set-default", response_model=SequenceResponse)
async def clear_sequence_default(
    sequence_id: UUID,
    db: DBConnection,
) -> SequenceResponse:
    """Remove default status from a sequence."""
    existing = await SequenceQueries.get_by_id(db, sequence_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if not existing.get("is_default"):
        raise HTTPException(status_code=400, detail="Sequence is not a default")

    sequence = await SequenceQueries.update(db, sequence_id, is_default=False)
    return SequenceResponse(**sequence, steps=existing.get("steps", []))


# =============================================================================
# SEQUENCE STEPS
# =============================================================================


@router.post("/{sequence_id}/steps", status_code=201)
async def create_step(
    sequence_id: UUID,
    data: SequenceStepCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> dict:
    """Create a step in a sequence."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if sequence["status"] == "active":
        raise HTTPException(
            status_code=400,
            detail="Cannot modify active sequence",
        )

    step = await SequenceQueries.create_step(
        db,
        sequence_id=sequence_id,
        org_id=org_id,
        position=data.position,
        default_delay_hours=data.default_delay_hours,
    )
    return step


@router.get("/{sequence_id}/steps")
async def list_steps(
    sequence_id: UUID,
    db: DBConnection,
) -> list[dict]:
    """List all steps for a sequence."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    return await SequenceQueries.list_steps(db, sequence_id)


@router.patch("/{sequence_id}/steps/{step_id}")
async def update_step(
    sequence_id: UUID,
    step_id: UUID,
    data: SequenceStepUpdate,
    db: DBConnection,
) -> dict:
    """Update a step."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if sequence["status"] == "active":
        raise HTTPException(
            status_code=400,
            detail="Cannot modify active sequence",
        )

    step = await SequenceQueries.get_step(db, step_id)
    if not step or step["sequence_id"] != sequence_id:
        raise HTTPException(status_code=404, detail="Step not found")

    update_data = data.model_dump(exclude_unset=True)
    return await SequenceQueries.update_step(db, step_id, **update_data)


@router.delete("/{sequence_id}/steps/{step_id}", status_code=204)
async def delete_step(
    sequence_id: UUID,
    step_id: UUID,
    db: DBConnection,
) -> None:
    """Delete a step."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if sequence["status"] == "active":
        raise HTTPException(
            status_code=400,
            detail="Cannot modify active sequence",
        )

    step = await SequenceQueries.get_step(db, step_id)
    if not step or step["sequence_id"] != sequence_id:
        raise HTTPException(status_code=404, detail="Step not found")

    await SequenceQueries.delete_step(db, step_id)


# =============================================================================
# ENROLLMENTS
# =============================================================================


@router.post("/{sequence_id}/enrollments", response_model=EnrollmentResponse, status_code=201)
async def enroll_target(
    sequence_id: UUID,
    data: EnrollmentCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> EnrollmentResponse:
    """Enroll a target in a sequence."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    if sequence["status"] != "active":
        raise HTTPException(
            status_code=400,
            detail="Can only enroll in active sequences",
        )

    # Check for existing active enrollment
    existing = await SequenceQueries.get_active_enrollment(db, data.target_id, sequence_id)
    if existing:
        raise HTTPException(
            status_code=409,
            detail="Target already enrolled in this sequence",
        )

    # Pass None when delay not specified (or is 0) to use step's configured delay
    enrollment = await SequenceQueries.enroll(
        db,
        org_id=org_id,
        target_id=data.target_id,
        sequence_id=sequence_id,
        first_step_delay_hours=data.first_step_delay_hours if data.first_step_delay_hours else None,
    )
    return EnrollmentResponse(**enrollment)


@router.get("/{sequence_id}/enrollments", response_model=ListResponse)
async def list_enrollments(
    sequence_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
    status: Optional[str] = Query(None, pattern="^(active|paused|completed|converted|exited)$"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List enrollments for a sequence."""
    sequence = await SequenceQueries.get_by_id(db, sequence_id)
    if not sequence:
        raise HTTPException(status_code=404, detail="Sequence not found")

    enrollments = await SequenceQueries.list_enrollments(
        db,
        org_id=org_id,
        sequence_id=sequence_id,
        status=status,
        limit=limit,
        offset=offset,
    )

    return ListResponse(
        items=[EnrollmentResponse(**e) for e in enrollments],
        total=len(enrollments),
        limit=limit,
        offset=offset,
    )


@router.get("/enrollments/{enrollment_id}", response_model=EnrollmentResponse)
async def get_enrollment(
    enrollment_id: UUID,
    db: DBConnection,
) -> EnrollmentResponse:
    """Get an enrollment by ID."""
    enrollment = await SequenceQueries.get_enrollment(db, enrollment_id)
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")
    return EnrollmentResponse(**enrollment)


@router.post("/enrollments/{enrollment_id}/pause", response_model=EnrollmentResponse)
async def pause_enrollment(
    enrollment_id: UUID,
    db: DBConnection,
) -> EnrollmentResponse:
    """Pause an active enrollment."""
    enrollment = await SequenceQueries.pause_enrollment(db, enrollment_id)
    if not enrollment:
        raise HTTPException(
            status_code=400,
            detail="Enrollment not found or not active",
        )
    return EnrollmentResponse(**enrollment)


@router.post("/enrollments/{enrollment_id}/resume", response_model=EnrollmentResponse)
async def resume_enrollment(
    enrollment_id: UUID,
    db: DBConnection,
) -> EnrollmentResponse:
    """Resume a paused enrollment."""
    enrollment = await SequenceQueries.resume_enrollment(db, enrollment_id)
    if not enrollment:
        raise HTTPException(
            status_code=400,
            detail="Enrollment not found or not paused",
        )
    return EnrollmentResponse(**enrollment)


@router.post("/enrollments/{enrollment_id}/exit", response_model=EnrollmentResponse)
async def exit_enrollment(
    enrollment_id: UUID,
    db: DBConnection,
    reason: Optional[str] = Query(None, max_length=50),
) -> EnrollmentResponse:
    """Exit an enrollment manually."""
    enrollment = await SequenceQueries.complete_enrollment(
        db,
        enrollment_id,
        status="exited",
        exit_reason=reason or "manual_exit",
    )
    if not enrollment:
        raise HTTPException(
            status_code=400,
            detail="Enrollment not found or already completed",
        )
    return EnrollmentResponse(**enrollment)


@router.get("/enrollments/{enrollment_id}/executions", response_model=list[StepExecutionResponse])
async def list_executions(
    enrollment_id: UUID,
    db: DBConnection,
) -> list[StepExecutionResponse]:
    """List step executions for an enrollment."""
    enrollment = await SequenceQueries.get_enrollment(db, enrollment_id)
    if not enrollment:
        raise HTTPException(status_code=404, detail="Enrollment not found")

    executions = await SequenceQueries.list_executions(db, enrollment_id)
    return [StepExecutionResponse(**e) for e in executions]

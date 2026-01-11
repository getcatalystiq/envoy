"""Content router."""

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request

from app.dependencies import CurrentOrg, DBConnection, MavenDep
from app.schemas import (
    ContentCreate,
    ContentGenerate,
    ContentGenerateToOutbox,
    ContentResponse,
    ContentUpdate,
    ListResponse,
    OutboxResponse,
)
from shared.queries import ContentQueries, OutboxQueries, TargetQueries

router = APIRouter()


@router.post("", response_model=ContentResponse, status_code=201)
async def create_content(
    data: ContentCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> ContentResponse:
    """Create new content."""
    content = await ContentQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        content_type=data.content_type,
        channel=data.channel,
        subject=data.subject,
        body=data.body,
        target_type_id=data.target_type_id,
        segment_id=data.segment_id,
        lifecycle_stage=data.lifecycle_stage,
    )
    return ContentResponse(**content)


@router.get("", response_model=ListResponse)
async def list_content(
    org_id: CurrentOrg,
    db: DBConnection,
    content_type: Optional[str] = None,
    channel: Optional[str] = None,
    target_type_id: Optional[UUID] = None,
    segment_id: Optional[UUID] = None,
    lifecycle_stage: Optional[int] = Query(None, ge=0, le=6),
    status: Optional[str] = Query(None, pattern="^(draft|active|archived)$"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> ListResponse:
    """List content with optional filters."""
    items = await ContentQueries.list(
        db,
        org_id=org_id,
        content_type=content_type,
        channel=channel,
        target_type_id=target_type_id,
        segment_id=segment_id,
        lifecycle_stage=lifecycle_stage,
        status=status,
        limit=limit,
        offset=offset,
    )

    return ListResponse(
        items=[ContentResponse(**c) for c in items],
        total=len(items),  # TODO: Add count query
        limit=limit,
        offset=offset,
    )


@router.get("/{content_id}", response_model=ContentResponse)
async def get_content(
    content_id: UUID,
    db: DBConnection,
) -> ContentResponse:
    """Get content by ID."""
    content = await ContentQueries.get_by_id(db, content_id)
    if not content:
        raise HTTPException(status_code=404, detail="Content not found")
    return ContentResponse(**content)


@router.patch("/{content_id}", response_model=ContentResponse)
async def update_content(
    content_id: UUID,
    data: ContentUpdate,
    db: DBConnection,
) -> ContentResponse:
    """Update content."""
    existing = await ContentQueries.get_by_id(db, content_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Content not found")

    update_data = data.model_dump(exclude_unset=True)
    content = await ContentQueries.update(db, content_id, **update_data)
    return ContentResponse(**content)


@router.delete("/{content_id}", status_code=204)
async def delete_content(
    content_id: UUID,
    db: DBConnection,
) -> None:
    """Delete content."""
    deleted = await ContentQueries.delete(db, content_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Content not found")


@router.post("/generate", response_model=ContentResponse)
async def generate_content(
    request: Request,
    data: ContentGenerate,
    org_id: CurrentOrg,
    db: DBConnection,
    maven: MavenDep,
) -> ContentResponse:
    """Generate content using AI for a specific target."""
    # Rate limit: 10/minute (configured in main.py via decorator would need slowapi)
    limiter = request.app.state.limiter

    # Get target
    target = await TargetQueries.get_by_id(db, data.target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")

    # Generate content via Maven
    result = await maven.generate_content(
        target=target,
        content_type=data.content_type,
    )

    # Save generated content
    content = await ContentQueries.create(
        db,
        org_id=org_id,
        name=f"AI Generated - {target['email']} - {data.content_type}",
        content_type=data.content_type,
        channel=data.channel,
        subject=result.get("subject"),
        body=result.get("body", result.get("raw", "")),
        target_type_id=target.get("target_type_id"),
        segment_id=target.get("segment_id"),
        lifecycle_stage=target.get("lifecycle_stage"),
        status="draft",
    )

    return ContentResponse(**content)


@router.post("/generate-to-outbox", response_model=OutboxResponse, status_code=201)
async def generate_content_to_outbox(
    request: Request,
    data: ContentGenerateToOutbox,
    org_id: CurrentOrg,
    db: DBConnection,
    maven: MavenDep,
) -> OutboxResponse:
    """Generate content using AI and send to outbox for human review."""
    # Get target
    target = await TargetQueries.get_by_id(db, data.target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")

    # Generate content via Maven
    result = await maven.generate_content(
        target=target,
        content_type=data.content_type,
    )

    # Extract confidence score from Maven result if available
    confidence_score = result.get("confidence_score")
    skill_reasoning = result.get("reasoning") or result.get("transcript")

    # Create outbox item for human review
    outbox_item = await OutboxQueries.create(
        db,
        org_id=org_id,
        target_id=data.target_id,
        channel=data.channel,
        subject=result.get("subject"),
        body=result.get("body", result.get("raw", "")),
        skill_name=data.content_type,
        skill_reasoning=skill_reasoning,
        confidence_score=confidence_score,
        priority=data.priority,
    )

    return OutboxResponse(**outbox_item)

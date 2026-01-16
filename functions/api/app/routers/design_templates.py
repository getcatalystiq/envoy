"""Design templates API routes."""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.dependencies import CurrentOrg, DBConnection
from app.schemas import (
    DesignTemplateCreate,
    DesignTemplatePreviewRequest,
    DesignTemplatePreviewResponse,
    DesignTemplateResponse,
    DesignTemplateUpdate,
)
from shared.queries.design_templates import DesignTemplateQueries

router = APIRouter()


# Default email-builder-js content structure for new templates (TReaderDocument format)
DEFAULT_BUILDER_CONTENT = {
    "root": {
        "type": "EmailLayout",
        "data": {
            "backdropColor": "#F5F5F5",
            "canvasColor": "#FFFFFF",
            "textColor": "#242424",
            "fontFamily": "MODERN_SANS",
            "childrenIds": ["content-block"],
        },
    },
    "content-block": {
        "type": "Text",
        "data": {
            "style": {"padding": {"top": 24, "bottom": 24, "left": 24, "right": 24}},
            "props": {"text": "Start writing your email here..."},
        },
    },
}


@router.get("", response_model=list[DesignTemplateResponse])
async def list_templates(
    org_id: CurrentOrg,
    db: DBConnection,
    include_archived: bool = False,
) -> list[DesignTemplateResponse]:
    """List all design templates."""
    templates = await DesignTemplateQueries.list(db, org_id, include_archived)
    return [DesignTemplateResponse(**t) for t in templates]


@router.post("", response_model=DesignTemplateResponse, status_code=201)
async def create_template(
    data: DesignTemplateCreate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> DesignTemplateResponse:
    """Create a new design template."""
    # Use default builder content if none provided
    builder_content = data.builder_content or DEFAULT_BUILDER_CONTENT

    template = await DesignTemplateQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        description=data.description,
        builder_content=builder_content,
    )
    return DesignTemplateResponse(**template)


@router.get("/{template_id}", response_model=DesignTemplateResponse)
async def get_template(
    template_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> DesignTemplateResponse:
    """Get a specific design template."""
    template = await DesignTemplateQueries.get(db, template_id, org_id)
    if not template:
        raise HTTPException(404, "Template not found")
    return DesignTemplateResponse(**template)


@router.patch("/{template_id}", response_model=DesignTemplateResponse)
async def update_template(
    template_id: UUID,
    data: DesignTemplateUpdate,
    org_id: CurrentOrg,
    db: DBConnection,
) -> DesignTemplateResponse:
    """Update a design template."""
    template = await DesignTemplateQueries.update(
        db,
        template_id=template_id,
        org_id=org_id,
        name=data.name,
        description=data.description,
        builder_content=data.builder_content,
        html_compiled=data.html_compiled,
        archived=data.archived,
    )
    if not template:
        raise HTTPException(404, "Template not found")
    return DesignTemplateResponse(**template)


@router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> None:
    """Delete a design template."""
    deleted = await DesignTemplateQueries.delete(db, template_id, org_id)
    if not deleted:
        raise HTTPException(404, "Template not found")


@router.post("/preview", response_model=DesignTemplatePreviewResponse)
async def preview_template(
    request: DesignTemplatePreviewRequest,
) -> DesignTemplatePreviewResponse:
    """Generate preview HTML for a design template.

    Note: email-builder-js content preview is handled client-side using the renderToStaticMarkup function.
    This endpoint returns an informational message.
    """
    # Email-builder content preview is handled client-side
    return DesignTemplatePreviewResponse(
        html="",
        text="",
        errors=["Email builder content preview is handled client-side"],
    )

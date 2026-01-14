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
from shared import mjml
from shared.queries.design_templates import DesignTemplateQueries

router = APIRouter()


# Default Maily content structure for new templates
DEFAULT_MAILY_CONTENT = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "attrs": {"textAlign": "left"},
            "content": [{"type": "text", "text": "Start writing your email here..."}],
        }
    ],
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
    html_compiled = None

    if data.editor_type == "mjml" and data.mjml_source:
        # Compile MJML (validates syntax)
        html_compiled, errors = mjml.compile(data.mjml_source)
        if errors:
            raise HTTPException(400, f"Invalid MJML: {errors}")

    # Use default Maily content if creating a Maily template without content
    maily_content = data.maily_content
    if data.editor_type == "maily" and not maily_content:
        maily_content = DEFAULT_MAILY_CONTENT

    template = await DesignTemplateQueries.create(
        db,
        org_id=org_id,
        name=data.name,
        description=data.description,
        editor_type=data.editor_type,
        mjml_source=data.mjml_source,
        maily_content=maily_content,
        html_compiled=html_compiled,
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
    # Recompile if MJML changed
    html_compiled = None
    if data.mjml_source:
        html_compiled, errors = mjml.compile(data.mjml_source)
        if errors:
            raise HTTPException(400, f"Invalid MJML: {errors}")

    template = await DesignTemplateQueries.update(
        db,
        template_id=template_id,
        org_id=org_id,
        name=data.name,
        description=data.description,
        mjml_source=data.mjml_source,
        maily_content=data.maily_content,
        html_compiled=html_compiled,
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
    # Check if in use
    usage_count = await DesignTemplateQueries.get_usage_count(db, template_id)
    if usage_count > 0:
        raise HTTPException(
            400,
            f"Template is used by {usage_count} content items. Archive it instead.",
        )

    deleted = await DesignTemplateQueries.delete(db, template_id, org_id)
    if not deleted:
        raise HTTPException(404, "Template not found")


@router.post("/preview", response_model=DesignTemplatePreviewResponse)
async def preview_template(
    request: DesignTemplatePreviewRequest,
) -> DesignTemplatePreviewResponse:
    """Generate preview HTML from MJML source.

    Note: Maily content preview is handled client-side using @maily-to/render.
    This endpoint is primarily for MJML templates.
    """
    if request.mjml_source:
        try:
            html, text = mjml.preview(request.mjml_source, request.sample_data)
            return DesignTemplatePreviewResponse(html=html, text=text)
        except ValueError as e:
            return DesignTemplatePreviewResponse(html="", text="", errors=[str(e)])

    # For Maily content, return empty - client handles rendering
    return DesignTemplatePreviewResponse(
        html="",
        text="",
        errors=["Maily content preview is handled client-side"],
    )

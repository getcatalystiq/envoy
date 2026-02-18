"""AgentPlane API proxy routes.

Skills, Connectors, and Runs management via AgentPlane admin API.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from httpx import ConnectError, HTTPStatusError, TimeoutException
from pydantic import BaseModel, ConfigDict

from app.dependencies import AgentPlaneDep

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Error handling ──────────────────────────────────────────────────────────


def _raise_for_upstream_error(exc: HTTPStatusError) -> None:
    """Convert upstream HTTP errors to appropriate FastAPI responses."""
    status = exc.response.status_code
    try:
        detail = exc.response.json().get("detail", exc.response.text)
    except Exception:
        detail = exc.response.text

    if 400 <= status < 500:
        raise HTTPException(status_code=status, detail=detail)
    else:
        logger.error("AgentPlane upstream error: %d: %s", status, detail)
        raise HTTPException(status_code=502, detail="AgentPlane service error")


# ─── Schemas ─────────────────────────────────────────────────────────────────


class SkillCreateRequest(BaseModel):
    name: str
    slug: str
    prompt: str
    description: Optional[str] = None


class SkillUpdateRequest(BaseModel):
    name: Optional[str] = None
    prompt: Optional[str] = None
    description: Optional[str] = None


class SkillResponse(BaseModel):
    model_config = ConfigDict(extra="allow")
    folder: str


class AddToolkitsRequest(BaseModel):
    slugs: list[str]


class SaveApiKeyRequest(BaseModel):
    api_key: str


# ─── Skills ──────────────────────────────────────────────────────────────────


@router.get("/skills")
async def list_skills(client: AgentPlaneDep):
    """List all skills for the organization."""
    try:
        skills = await client.list_skills()
        return {"skills": skills}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.post("/skills", status_code=201)
async def create_skill(body: SkillCreateRequest, client: AgentPlaneDep):
    """Create a new skill."""
    try:
        files = [{"path": "SKILL.md", "content": f"---\nname: {body.name}\ndescription: {body.description or ''}\n---\n\n{body.prompt}"}]
        skill = await client.create_skill(folder=body.slug, files=files)
        return skill
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.get("/skills/{folder}")
async def get_skill(folder: str, client: AgentPlaneDep):
    """Get a specific skill by folder name."""
    try:
        skill = await client.get_skill(folder)
        if not skill:
            raise HTTPException(status_code=404, detail="Skill not found")
        return skill
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.patch("/skills/{folder}")
async def update_skill(folder: str, body: SkillUpdateRequest, client: AgentPlaneDep):
    """Update a skill's files."""
    try:
        # Build updated SKILL.md content
        parts = ["---"]
        if body.name:
            parts.append(f"name: {body.name}")
        if body.description is not None:
            parts.append(f"description: {body.description}")
        parts.append("---\n")
        if body.prompt:
            parts.append(body.prompt)

        files = [{"path": "SKILL.md", "content": "\n".join(parts)}]
        return await client.update_skill(folder=folder, files=files)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.delete("/skills/{folder}")
async def delete_skill(folder: str, client: AgentPlaneDep):
    """Delete a skill."""
    try:
        await client.delete_skill(folder)
        return {"status": "deleted"}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


# ─── Connectors ──────────────────────────────────────────────────────────────


@router.get("/connectors")
async def list_connectors(client: AgentPlaneDep):
    """List connector statuses for the agent."""
    try:
        connectors = await client.list_connectors()
        return {"connectors": connectors}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.get("/toolkits")
async def list_toolkits(client: AgentPlaneDep):
    """List available Composio toolkits."""
    try:
        toolkits = await client.list_toolkits()
        return {"toolkits": toolkits}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.post("/connectors/add")
async def add_toolkits(body: AddToolkitsRequest, client: AgentPlaneDep):
    """Add toolkit(s) to the agent."""
    try:
        return await client.add_toolkits(body.slugs)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.delete("/connectors/{slug}")
async def remove_toolkit(slug: str, client: AgentPlaneDep):
    """Remove a toolkit from the agent."""
    try:
        await client.remove_toolkit(slug)
        return {"status": "removed"}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.post("/connectors/{slug}/api-key")
async def save_connector_api_key(slug: str, body: SaveApiKeyRequest, client: AgentPlaneDep):
    """Save API key for a toolkit connector."""
    try:
        return await client.save_api_key(slug, body.api_key)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.post("/connectors/{slug}/oauth")
async def initiate_connector_oauth(slug: str, client: AgentPlaneDep):
    """Initiate OAuth flow for a connector. Returns { redirect_url }."""
    try:
        return await client.initiate_oauth(slug)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


# ─── Runs / Activity ────────────────────────────────────────────────────────


@router.get("/runs")
async def list_runs(
    client: AgentPlaneDep,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: Optional[str] = None,
):
    """List runs for the agent."""
    try:
        return await client.list_runs(limit=limit, offset=offset, status=status)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")


@router.get("/runs/{run_id}")
async def get_run(run_id: str, client: AgentPlaneDep):
    """Get run details including transcript."""
    try:
        return await client.get_run(run_id)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")

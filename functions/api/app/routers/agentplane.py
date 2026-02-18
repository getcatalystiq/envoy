"""AgentPlane API proxy routes.

Runs management, skills (via agent CRUD), and connectors via AgentPlane tenant API.
"""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from httpx import ConnectError, HTTPStatusError, TimeoutException
from pydantic import BaseModel, Field

from app.dependencies import AgentPlaneDep

logger = logging.getLogger(__name__)
router = APIRouter()


# ─── Schemas ────────────────────────────────────────────────────────────────


class SkillCreate(BaseModel):
    name: str = Field(..., min_length=1)
    slug: str = Field(..., min_length=1)
    description: str | None = None
    prompt: str = Field(..., min_length=1)


class SkillUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    prompt: str | None = None


class ApiKeyBody(BaseModel):
    api_key: str = Field(..., min_length=1)


# ─── Error handling ──────────────────────────────────────────────────────────


def _raise_for_upstream_error(exc: HTTPStatusError) -> None:
    """Convert upstream HTTP errors to appropriate FastAPI responses."""
    status = exc.response.status_code
    try:
        detail = exc.response.json().get("detail", exc.response.text)
    except Exception:
        detail = exc.response.text

    if status in (401, 403):
        # Upstream auth failures are a backend config issue, not a client session
        # problem. Return 502 to avoid triggering the frontend's logout logic.
        logger.error("AgentPlane auth error: %d: %s", status, detail)
        raise HTTPException(status_code=502, detail="AgentPlane authentication failed")
    elif 400 <= status < 500:
        raise HTTPException(status_code=status, detail=detail)
    else:
        logger.error("AgentPlane upstream error: %d: %s", status, detail)
        raise HTTPException(status_code=502, detail="AgentPlane service error")


# ─── Runs / Activity ────────────────────────────────────────────────────────


@router.get("/runs")
async def list_runs(
    client: AgentPlaneDep,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str | None = None,
):
    """List runs for the agent."""
    try:
        return await client.list_runs(limit=limit, offset=offset, status=status)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.get("/runs/{run_id}")
async def get_run(run_id: str, client: AgentPlaneDep):
    """Get run details."""
    try:
        run = await client.get_run(run_id)
        run["transcript"] = await client.get_run_transcript(run_id)
        return run
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


# ─── Skills (via agent CRUD) ────────────────────────────────────────────────


@router.get("/skills")
async def list_skills(client: AgentPlaneDep):
    """List skills from the agent's skills array."""
    try:
        agent = await client.get_agent()
        return {"skills": agent.get("skills", [])}
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.post("/skills")
async def create_skill(body: SkillCreate, client: AgentPlaneDep):
    """Add a skill to the agent's skills array."""
    try:
        agent = await client.get_agent()
        skills: list[dict[str, Any]] = agent.get("skills", [])

        # Check for duplicate slug
        if any(s.get("slug") == body.slug for s in skills):
            raise HTTPException(status_code=409, detail="Skill with this slug already exists")

        new_skill = body.model_dump()
        skills.append(new_skill)
        await client.update_agent({"skills": skills})
        return new_skill
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.get("/skills/{skill_slug}")
async def get_skill(skill_slug: str, client: AgentPlaneDep):
    """Get a single skill by slug."""
    try:
        agent = await client.get_agent()
        for skill in agent.get("skills", []):
            if skill.get("slug") == skill_slug:
                return skill
        raise HTTPException(status_code=404, detail="Skill not found")
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.patch("/skills/{skill_slug}")
async def update_skill(skill_slug: str, body: SkillUpdate, client: AgentPlaneDep):
    """Update a skill in the agent's skills array."""
    try:
        agent = await client.get_agent()
        skills: list[dict[str, Any]] = agent.get("skills", [])

        for i, skill in enumerate(skills):
            if skill.get("slug") == skill_slug:
                updates = body.model_dump(exclude_unset=True)
                skills[i] = {**skill, **updates}
                await client.update_agent({"skills": skills})
                return skills[i]

        raise HTTPException(status_code=404, detail="Skill not found")
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.delete("/skills/{skill_slug}")
async def delete_skill(skill_slug: str, client: AgentPlaneDep):
    """Remove a skill from the agent's skills array."""
    try:
        agent = await client.get_agent()
        skills: list[dict[str, Any]] = agent.get("skills", [])
        new_skills = [s for s in skills if s.get("slug") != skill_slug]

        if len(new_skills) == len(skills):
            raise HTTPException(status_code=404, detail="Skill not found")

        await client.update_agent({"skills": new_skills})
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


# ─── Connectors ─────────────────────────────────────────────────────────────


@router.get("/connectors")
async def list_connectors(client: AgentPlaneDep):
    """List connector statuses for the agent's toolkits."""
    try:
        return await client.list_connectors()
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.post("/connectors/{slug}/oauth")
async def initiate_oauth(slug: str, client: AgentPlaneDep):
    """Start OAuth flow for a connector, returns redirect_url."""
    try:
        return await client.initiate_connector_oauth(slug)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.post("/connectors/{slug}/api-key")
async def save_api_key(slug: str, body: ApiKeyBody, client: AgentPlaneDep):
    """Save API key for a connector."""
    try:
        return await client.save_connector_api_key(slug, body.api_key)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.delete("/connectors/{slug}")
async def disconnect_connector(slug: str, client: AgentPlaneDep):
    """Remove a connector connection."""
    try:
        await client.delete_connector(slug)
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e

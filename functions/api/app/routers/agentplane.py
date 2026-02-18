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


class FileCreate(BaseModel):
    path: str = Field(..., min_length=1)
    file_type: str = "file"


class FileSave(BaseModel):
    content: str


class SkillPublish(BaseModel):
    skill_slug: str


class ApiKeyBody(BaseModel):
    api_key: str = Field(..., min_length=1)


# ─── Transformers ───────────────────────────────────────────────────────────


def _parse_skill(raw: dict[str, Any]) -> dict[str, Any]:
    """Parse a folder-based skill into {name, slug, description, prompt}."""
    folder = raw.get("folder", "")
    result: dict[str, Any] = {"slug": folder, "name": folder, "description": None, "prompt": ""}

    skill_md = next((f for f in raw.get("files", []) if f.get("path") == "SKILL.md"), None)
    if not skill_md or not skill_md.get("content"):
        return result

    content: str = skill_md["content"]
    if content.startswith("---"):
        marker = content.find("---", 3)
        if marker > 0:
            frontmatter = content[3:marker]
            for line in frontmatter.strip().splitlines():
                if line.startswith("name:"):
                    result["name"] = line[5:].strip()
                elif line.startswith("description:"):
                    result["description"] = line[12:].strip()
            result["prompt"] = content[marker + 3:].strip()
        else:
            result["prompt"] = content
    else:
        result["prompt"] = content

    return result


def _build_skill_md(name: str, description: str | None, prompt: str) -> str:
    """Build SKILL.md content from structured fields."""
    lines = ["---", f"name: {name}"]
    if description:
        lines.append(f"description: {description}")
    lines.append("---")
    lines.append("")
    lines.append(prompt)
    return "\n".join(lines)


def _find_raw_skill(agent: dict[str, Any], folder: str) -> tuple[int, dict[str, Any]]:
    """Find a raw skill by folder name. Returns (index, skill) or raises 404."""
    for i, skill in enumerate(agent.get("skills", [])):
        if skill.get("folder") == folder:
            return i, skill
    raise HTTPException(status_code=404, detail="Skill not found")


def _normalize_connector(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize AgentPlane connector to frontend format."""
    connected = raw.get("connected", False)
    return {
        "slug": raw.get("slug", ""),
        "name": raw.get("name", ""),
        "logo": raw.get("logo", ""),
        "authScheme": raw.get("auth_scheme", "OTHER"),
        "authConfigId": None,
        "connectedAccountId": None,
        "connectionStatus": "ACTIVE" if connected else None,
    }


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
        parsed = [_parse_skill(s) for s in agent.get("skills", [])]
        return {"skills": parsed}
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

        if any(s.get("folder") == body.slug for s in skills):
            raise HTTPException(status_code=409, detail="Skill with this slug already exists")

        new_skill = {
            "folder": body.slug,
            "files": [{"path": "SKILL.md", "content": _build_skill_md(body.name, body.description, body.prompt)}],
        }
        skills.append(new_skill)
        await client.update_agent({"skills": skills})
        return _parse_skill(new_skill)
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.get("/skills/{skill_slug}")
async def get_skill(skill_slug: str, client: AgentPlaneDep):
    """Get a single skill by slug (SkillBuilder format: prompt=null for file mode)."""
    try:
        agent = await client.get_agent()
        _, raw = _find_raw_skill(agent, skill_slug)
        parsed = _parse_skill(raw)
        # Return SkillBuilder-compatible shape: prompt=null triggers file-based editor
        return {
            "id": parsed["slug"],
            "name": parsed["name"],
            "slug": parsed["slug"],
            "description": parsed["description"],
            "prompt": None,
            "enabled": True,
        }
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
            if skill.get("folder") == skill_slug:
                parsed = _parse_skill(skill)
                updates = body.model_dump(exclude_unset=True)
                name = updates.get("name", parsed["name"])
                desc = updates.get("description", parsed["description"])
                prompt = updates.get("prompt", parsed["prompt"])
                # Update SKILL.md but preserve other files
                new_md = _build_skill_md(name, desc, prompt)
                files = skill.get("files", [])
                updated = False
                for f in files:
                    if f.get("path") == "SKILL.md":
                        f["content"] = new_md
                        updated = True
                        break
                if not updated:
                    files.append({"path": "SKILL.md", "content": new_md})
                skills[i] = {"folder": skill_slug, "files": files}
                await client.update_agent({"skills": skills})
                return _parse_skill(skills[i])

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
        new_skills = [s for s in skills if s.get("folder") != skill_slug]

        if len(new_skills) == len(skills):
            raise HTTPException(status_code=404, detail="Skill not found")

        await client.update_agent({"skills": new_skills})
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


# ─── Skill Files ────────────────────────────────────────────────────────────


@router.get("/skills/{skill_slug}/files")
async def list_skill_files(skill_slug: str, client: AgentPlaneDep):
    """List files in a skill folder."""
    try:
        agent = await client.get_agent()
        _, raw = _find_raw_skill(agent, skill_slug)
        files = [
            {
                "name": f["path"].rsplit("/", 1)[-1],
                "path": f["path"],
                "type": "file",
                "size": len(f.get("content", "")),
            }
            for f in raw.get("files", [])
        ]
        return {"files": files}
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.get("/skills/{skill_slug}/files/{file_path:path}")
async def get_skill_file(skill_slug: str, file_path: str, client: AgentPlaneDep):
    """Get content of a file in a skill folder."""
    try:
        agent = await client.get_agent()
        _, raw = _find_raw_skill(agent, skill_slug)
        for f in raw.get("files", []):
            if f.get("path") == file_path:
                return {"content": f.get("content", "")}
        raise HTTPException(status_code=404, detail="File not found")
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.put("/skills/{skill_slug}/files/{file_path:path}")
async def save_skill_file(
    skill_slug: str, file_path: str, body: FileSave, client: AgentPlaneDep
):
    """Save content to a file in a skill folder."""
    try:
        agent = await client.get_agent()
        idx, raw = _find_raw_skill(agent, skill_slug)
        skills = agent["skills"]

        files = raw.get("files", [])
        for f in files:
            if f.get("path") == file_path:
                f["content"] = body.content
                break
        else:
            raise HTTPException(status_code=404, detail="File not found")

        skills[idx] = {**raw, "files": files}
        await client.update_agent({"skills": skills})
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.post("/skills/{skill_slug}/files")
async def create_skill_file(skill_slug: str, body: FileCreate, client: AgentPlaneDep):
    """Create a new file in a skill folder."""
    try:
        agent = await client.get_agent()
        idx, raw = _find_raw_skill(agent, skill_slug)
        skills = agent["skills"]

        files = raw.get("files", [])
        if any(f.get("path") == body.path for f in files):
            raise HTTPException(status_code=409, detail="File already exists")

        files.append({"path": body.path, "content": ""})
        skills[idx] = {**raw, "files": files}
        await client.update_agent({"skills": skills})
        return {"path": body.path}
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.delete("/skills/{skill_slug}/files/{file_path:path}")
async def delete_skill_file(skill_slug: str, file_path: str, client: AgentPlaneDep):
    """Delete a file from a skill folder."""
    try:
        agent = await client.get_agent()
        idx, raw = _find_raw_skill(agent, skill_slug)
        skills = agent["skills"]

        files = raw.get("files", [])
        new_files = [f for f in files if f.get("path") != file_path]
        if len(new_files) == len(files):
            raise HTTPException(status_code=404, detail="File not found")

        skills[idx] = {**raw, "files": new_files}
        await client.update_agent({"skills": skills})
    except HTTPException:
        raise
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException) as e:
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable") from e


@router.post("/skills/{skill_slug}/publish")
async def publish_skill(skill_slug: str, client: AgentPlaneDep):
    """Publish a skill (saves current state as published)."""
    try:
        agent = await client.get_agent()
        _find_raw_skill(agent, skill_slug)
        # Skills are live on save via agent update; publish is a no-op confirmation.
        return {"status": "published"}
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
        result = await client.list_connectors()
        connectors = [_normalize_connector(c) for c in result.get("data", [])]
        return {"connectors": connectors}
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

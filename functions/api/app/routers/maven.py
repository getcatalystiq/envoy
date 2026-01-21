"""Maven Admin API proxy routes.

Thin wrapper around MavenClient for Skills, Connectors, and Invocations.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.dependencies import CurrentUser, MavenDep

router = APIRouter()


# === Skills ===


class SkillCreate(BaseModel):
    name: str
    slug: str
    prompt: str
    description: Optional[str] = None
    category: Optional[str] = None


class SkillUpdate(BaseModel):
    name: Optional[str] = None
    prompt: Optional[str] = None
    description: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("/skills")
async def list_skills(maven: MavenDep):
    """List all skills for the organization."""
    return await maven.list_skills()


@router.post("/skills")
async def create_skill(body: SkillCreate, maven: MavenDep):
    """Create a new skill."""
    return await maven.create_skill(body.model_dump())


@router.get("/skills/{skill_id}")
async def get_skill(skill_id: str, maven: MavenDep):
    """Get a specific skill."""
    return await maven.get_skill(skill_id)


@router.patch("/skills/{skill_id}")
async def update_skill(skill_id: str, body: SkillUpdate, maven: MavenDep):
    """Update an existing skill."""
    return await maven.update_skill(skill_id, body.model_dump(exclude_unset=True))


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: str, maven: MavenDep):
    """Delete a skill."""
    await maven.delete_skill(skill_id)
    return {"status": "deleted"}


# === Connectors ===


@router.get("/connectors")
async def list_connectors(maven: MavenDep):
    """List connectors with envoy-service connection status."""
    return await maven.get_service_connector_status()


@router.post("/connectors/{connector_id}/connect")
async def initiate_connector_oauth(
    connector_id: str,
    request: Request,
    maven: MavenDep,
    user: CurrentUser,
):
    """
    Start OAuth flow for connector.
    Returns authorization_url for popup.
    Admin authenticates, token stored for envoy-service.
    """
    origin = request.headers.get("origin", "")
    user_id = user.get("sub") or user.get("id")
    if not user_id:
        raise HTTPException(status_code=400, detail="User ID not found in token")

    return await maven.initiate_service_oauth(
        connector_id=connector_id,
        admin_user_id=user_id,
        origin=origin,
    )


@router.post("/connectors/{connector_id}/disconnect")
async def disconnect_connector(connector_id: str, maven: MavenDep):
    """Disconnect envoy-service from connector."""
    await maven.disconnect_service_connector(connector_id)
    return {"status": "disconnected"}


# === Invocations ===


@router.get("/invocations")
async def list_invocations(maven: MavenDep, limit: int = 50):
    """List recent AI invocations for envoy-service."""
    return await maven.list_invocations(limit=limit)


@router.get("/invocations/{session_id}")
async def get_invocation(session_id: str, maven: MavenDep):
    """Get invocation details including transcript."""
    return await maven.get_invocation(session_id)

"""FastAPI dependencies for Envoy API."""

from typing import Annotated, Any, AsyncGenerator

import asyncpg
from fastapi import Depends, HTTPException

from shared.agentplane_client import AgentPlaneClient
from shared.auth import get_current_org, get_current_user, verify_jwt
from shared.database import get_connection

# Type aliases for dependency injection
CurrentOrg = Annotated[str, Depends(get_current_org)]
CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]
TokenClaims = Annotated[dict[str, Any], Depends(verify_jwt)]


async def get_db(org_id: CurrentOrg) -> AsyncGenerator[asyncpg.Connection, None]:
    """Get database connection with RLS context."""
    async with get_connection(org_id) as conn:
        yield conn


DBConnection = Annotated[asyncpg.Connection, Depends(get_db)]



async def get_agentplane_client(org_id: CurrentOrg, db: DBConnection) -> AgentPlaneClient:
    """Get AgentPlane client for the current organization."""
    org = await db.fetchrow(
        "SELECT agentplane_tenant_id, agentplane_agent_id FROM organizations WHERE id = $1",
        org_id,
    )
    if not org or not org["agentplane_agent_id"]:
        raise HTTPException(status_code=503, detail="Organization not configured for AgentPlane")
    return AgentPlaneClient(
        tenant_id=org["agentplane_tenant_id"] or org_id,
        agent_id=org["agentplane_agent_id"],
    )


AgentPlaneDep = Annotated[AgentPlaneClient, Depends(get_agentplane_client)]

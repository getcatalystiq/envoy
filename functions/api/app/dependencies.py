"""FastAPI dependencies for Envoy API."""

from typing import Annotated, Any, AsyncGenerator

import asyncpg
from fastapi import Depends

from shared.auth import get_current_org, get_current_user, verify_jwt
from shared.database import get_connection
from shared.maven_client import MavenClient

# Type aliases for dependency injection
CurrentOrg = Annotated[str, Depends(get_current_org)]
CurrentUser = Annotated[dict[str, Any], Depends(get_current_user)]
TokenClaims = Annotated[dict[str, Any], Depends(verify_jwt)]


async def get_db(org_id: CurrentOrg) -> AsyncGenerator[asyncpg.Connection, None]:
    """Get database connection with RLS context."""
    async with get_connection(org_id) as conn:
        yield conn


DBConnection = Annotated[asyncpg.Connection, Depends(get_db)]


async def get_maven_client(org_id: CurrentOrg) -> MavenClient:
    """Get Maven client for the current organization."""
    # In production, fetch maven_tenant_id from organization record
    return MavenClient(tenant_id=org_id)


MavenDep = Annotated[MavenClient, Depends(get_maven_client)]

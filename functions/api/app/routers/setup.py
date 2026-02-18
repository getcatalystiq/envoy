"""Setup router for organization configuration status."""

import json

from fastapi import APIRouter

from app.dependencies import CurrentOrg, DBConnection

router = APIRouter()


@router.get("/status")
async def get_setup_status(
    org_id: CurrentOrg,
    db: DBConnection,
) -> dict:
    """Get current setup status for organization."""
    org = await db.fetchrow(
        """SELECT agentplane_tenant_id, agentplane_agent_id
           FROM organizations WHERE id = $1""",
        org_id,
    )

    return {
        "agentplane_configured": bool(
            org and org["agentplane_tenant_id"] and org["agentplane_agent_id"]
        ),
    }

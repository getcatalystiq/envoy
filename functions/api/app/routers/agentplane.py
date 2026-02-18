"""AgentPlane API proxy routes.

Runs management via AgentPlane tenant API.
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from httpx import ConnectError, HTTPStatusError, TimeoutException

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
    """Get run details."""
    try:
        run = await client.get_run(run_id)
        run["transcript"] = await client.get_run_transcript(run_id)
        return run
    except HTTPStatusError as e:
        _raise_for_upstream_error(e)
    except (ConnectError, TimeoutException):
        raise HTTPException(status_code=503, detail="AgentPlane service unavailable")

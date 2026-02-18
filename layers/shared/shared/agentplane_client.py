"""AgentPlane AI agent client with Bearer auth and NDJSON streaming."""

import json
import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

logger = logging.getLogger(__name__)

# Module-level key cache (cold-start optimization)
_agentplane_key: str | None = None


def _get_api_key() -> str:
    """Get AgentPlane tenant API key (for runtime invocations)."""
    global _agentplane_key
    if _agentplane_key is not None:
        return _agentplane_key

    key = os.environ.get("AGENTPLANE_API_KEY", "")
    if key:
        _agentplane_key = key
        return _agentplane_key

    raise ValueError("AgentPlane API key not configured")


# Timeout configurations
STREAMING_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=300.0,  # 5 min for AI streaming
    write=10.0,
    pool=10.0,
)

DEFAULT_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=30.0,
    write=10.0,
    pool=10.0,
)


class AgentPlaneError(Exception):
    """Error from AgentPlane API."""

    def __init__(self, message: str, code: str | None = None):
        self.message = message
        self.code = code
        super().__init__(message)


@dataclass
class RunResult:
    """Result from an AgentPlane run_agent call."""

    output: str
    session_id: str | None = None
    metadata: dict[str, Any] | None = None


def _is_retryable(exc: BaseException) -> bool:
    """Check if an exception is retryable."""
    if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout | httpx.PoolTimeout):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code == 429 or exc.response.status_code >= 500
    return False


class AgentPlaneClient:
    """Client for calling AgentPlane AI agent API."""

    def __init__(self, tenant_id: str, agent_id: str):
        self.tenant_id = tenant_id
        self.agent_id = agent_id
        self.base_url = os.environ.get("AGENTPLANE_API_URL", "")
        if not self.base_url:
            raise ValueError("AGENTPLANE_API_URL environment variable not set")

    def _headers(self) -> dict[str, str]:
        """Get auth headers."""
        return {
            "Authorization": f"Bearer {_get_api_key()}",
            "Content-Type": "application/json",
        }

    # ─── Runs / Activity (tenant API) ────────────────────────────────────

    async def list_runs(self, limit: int = 50, offset: int = 0, status: str | None = None) -> dict:
        """List runs for the agent via tenant API."""
        params = f"?limit={limit}&offset={offset}"
        if status:
            params += f"&status={status}"
        url = f"{self.base_url}/api/agents/{self.agent_id}/runs{params}"

        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            result = response.json()
        if not result:
            return {"runs": [], "total": 0}
        return {"runs": result.get("data", []), "total": len(result.get("data", []))}

    async def get_run(self, run_id: str) -> dict:
        """Get run status via tenant API."""
        url = f"{self.base_url}/api/runs/{run_id}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def get_run_transcript(self, run_id: str) -> list:
        """Get run transcript via tenant API (returns NDJSON)."""
        url = f"{self.base_url}/api/runs/{run_id}/transcript"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            entries = []
            for line in response.text.strip().split("\n"):
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
            return entries

    # ─── Runtime invocation ─────────────────────────────────────────────

    @retry(
        retry=retry_if_exception(_is_retryable),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        before_sleep=before_sleep_log(logger, logging.WARNING),
        reraise=True,
    )
    async def run_agent(self, prompt: str, max_turns: int | None = None, max_budget_usd: float | None = None) -> RunResult:
        """Run the agent with a prompt. Consumes NDJSON stream and returns result."""
        body: dict[str, Any] = {"prompt": prompt, "agent_id": self.agent_id}
        if max_turns is not None:
            body["max_turns"] = max_turns
        if max_budget_usd is not None:
            body["max_budget_usd"] = max_budget_usd

        url = f"{self.base_url}/api/runs"
        headers = self._headers()

        async with (
            httpx.AsyncClient(timeout=STREAMING_TIMEOUT) as client,
            client.stream("POST", url, headers=headers, json=body) as response,
        ):
            response.raise_for_status()
            return await self._consume_ndjson_stream(response)

    async def _consume_ndjson_stream(self, response: httpx.Response) -> RunResult:
        """Parse NDJSON stream and return the final result."""
        result: RunResult | None = None
        buffer_size = 0
        max_buffer = 4 * 1024 * 1024  # 4MB safety limit

        async for line in response.aiter_lines():
            line = line.strip()
            if not line:
                continue  # skip keepalives

            buffer_size += len(line)
            if buffer_size > max_buffer:
                raise AgentPlaneError("Response exceeded maximum buffer size")

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Skipping malformed NDJSON line: %s", line[:200])
                continue

            event_type = event.get("type")

            if event_type == "error":
                raise AgentPlaneError(
                    message=event.get("data", {}).get("message", "Unknown error"),
                    code=event.get("data", {}).get("code"),
                )

            if event_type == "result":
                # Result content is at event["result"], not event["data"]["output"]
                result = RunResult(
                    output=event.get("result", ""),
                    session_id=event.get("session_id"),
                    metadata={k: v for k, v in event.items() if k not in ("type", "subtype", "result", "session_id")},
                )
                # Continue draining to keep connection clean

        if result is None:
            raise AgentPlaneError("Stream ended without result event")
        return result

    # ─── Agent / Skills (tenant API) ────────────────────────────────────

    async def get_agent(self) -> dict:
        """Get agent details including skills."""
        url = f"{self.base_url}/api/agents/{self.agent_id}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def update_agent(self, data: dict) -> dict:
        """Update agent (e.g. skills array)."""
        url = f"{self.base_url}/api/agents/{self.agent_id}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.put(url, headers=self._headers(), json=data)
            response.raise_for_status()
            return response.json()

    # ─── Connectors (tenant API) ─────────────────────────────────────

    async def list_connectors(self) -> dict:
        """List connector statuses for agent's toolkits."""
        url = f"{self.base_url}/api/agents/{self.agent_id}/connectors"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.get(url, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def save_connector_api_key(self, toolkit: str, api_key: str) -> dict:
        """Save API key for a connector."""
        url = f"{self.base_url}/api/agents/{self.agent_id}/connectors"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.post(
                url, headers=self._headers(), json={"toolkit": toolkit, "api_key": api_key}
            )
            response.raise_for_status()
            return response.json()

    async def initiate_connector_oauth(self, toolkit: str) -> dict:
        """Start OAuth flow, returns redirect_url."""
        url = f"{self.base_url}/api/agents/{self.agent_id}/connectors/{toolkit}/initiate-oauth"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.post(url, headers=self._headers())
            response.raise_for_status()
            return response.json()

    async def delete_connector(self, toolkit: str) -> None:
        """Remove a connector connection."""
        url = f"{self.base_url}/api/agents/{self.agent_id}/connectors/{toolkit}"
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            response = await client.delete(url, headers=self._headers())
            response.raise_for_status()

    # ─── Convenience methods ────────────────────────────────────────────

    async def invoke_skill(self, skill_name: str, context: dict[str, Any]) -> dict[str, Any]:
        """Invoke a skill via run_agent."""
        prompt = f"use skill {skill_name}\n\nContext:\n{json.dumps(context, indent=2, default=str)}"
        result = await self.run_agent(prompt)
        return self._parse_skill_response(result.output)

    async def generate_content(self, target: dict[str, Any], content_type: str) -> dict[str, Any]:
        """Generate content for a target."""
        return await self.invoke_skill(
            "envoy-content-generation",
            {"target": target, "content_type": content_type},
        )

    @staticmethod
    def _parse_skill_response(response: str) -> dict[str, Any]:
        """Parse structured JSON response from skill output."""
        try:
            if "```json" in response:
                start = response.index("```json") + 7
                end = response.index("```", start)
                return json.loads(response[start:end].strip())
            return json.loads(response)
        except (json.JSONDecodeError, ValueError):
            return {"raw": response}

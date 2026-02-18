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

# Module-level key caches (cold-start optimization)
_agentplane_key: str | None = None
_agentplane_admin_key: str | None = None


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


def _get_admin_key() -> str:
    """Get AgentPlane admin key (for skills/connectors management)."""
    global _agentplane_admin_key
    if _agentplane_admin_key is not None:
        return _agentplane_admin_key

    key = os.environ.get("AGENTPLANE_ADMIN_KEY", "")
    if key:
        _agentplane_admin_key = key
        return _agentplane_admin_key

    raise ValueError("AgentPlane admin key not configured")


# Timeout configurations
STREAMING_TIMEOUT = httpx.Timeout(
    connect=10.0,
    read=300.0,  # 5 min for AI streaming
    write=10.0,
    pool=10.0,
)

ADMIN_TIMEOUT = httpx.Timeout(
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

    async def _admin_request(
        self, method: str, path: str, body: dict | None = None, timeout: httpx.Timeout | None = None
    ) -> dict | list | None:
        """Make admin API request with cookie auth (login first, then use session cookie)."""
        url = f"{self.base_url}{path}"
        timeout = timeout or ADMIN_TIMEOUT

        async with httpx.AsyncClient(timeout=timeout) as client:
            # Login to get session cookie
            login_resp = await client.post(
                f"{self.base_url}/api/admin/login",
                json={"password": _get_admin_key()},
            )
            login_resp.raise_for_status()

            # Use the session cookie for the actual request
            response = await client.request(
                method,
                url,
                json=body if body else None,
            )
            if response.status_code == 204:
                return None
            response.raise_for_status()
            return response.json()

    # ─── Skills (via Agent.skills array) ─────────────────────────────────

    async def list_skills(self) -> list[dict]:
        """List all skills for the agent."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        return result.get("agent", {}).get("skills", []) if result else []

    async def get_skill(self, folder: str) -> dict | None:
        """Get a specific skill by folder name."""
        skills = await self.list_skills()
        for skill in skills:
            if skill.get("folder") == folder:
                return skill
        return None

    async def create_skill(self, folder: str, files: list[dict]) -> dict:
        """Create a skill by adding to agent's skills array."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        agent = result.get("agent", {}) if result else {}
        skills = agent.get("skills", [])

        new_skill = {"folder": folder, "files": files}
        skills.append(new_skill)

        await self._admin_request(
            "PATCH",
            f"/api/admin/agents/{self.agent_id}",
            {"skills": skills},
        )
        return new_skill

    async def update_skill(self, folder: str, files: list[dict]) -> dict:
        """Update a skill's files."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        agent = result.get("agent", {}) if result else {}
        skills = agent.get("skills", [])

        updated_skill = {"folder": folder, "files": files}
        found = False
        for i, skill in enumerate(skills):
            if skill.get("folder") == folder:
                skills[i] = updated_skill
                found = True
                break

        if not found:
            raise AgentPlaneError(f"Skill '{folder}' not found")

        await self._admin_request(
            "PATCH",
            f"/api/admin/agents/{self.agent_id}",
            {"skills": skills},
        )
        return updated_skill

    async def delete_skill(self, folder: str) -> None:
        """Remove a skill from agent's skills array."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        agent = result.get("agent", {}) if result else {}
        skills = agent.get("skills", [])

        skills = [s for s in skills if s.get("folder") != folder]

        await self._admin_request(
            "PATCH",
            f"/api/admin/agents/{self.agent_id}",
            {"skills": skills},
        )

    # ─── Connectors ──────────────────────────────────────────────────────

    async def list_connectors(self) -> list[dict]:
        """List connector statuses for the agent."""
        result = await self._admin_request(
            "GET", f"/api/admin/agents/{self.agent_id}/connectors"
        )
        return result if isinstance(result, list) else []

    async def list_toolkits(self) -> list[dict]:
        """List available Composio toolkits."""
        result = await self._admin_request("GET", "/api/admin/composio/toolkits")
        return result.get("items", []) if result else []

    async def add_toolkits(self, slugs: list[str]) -> dict:
        """Add toolkit(s) to the agent's composio_toolkits array."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        agent = result.get("agent", {}) if result else {}
        current = agent.get("composio_toolkits", [])

        # Merge without duplicates
        merged = list(set(current + slugs))

        return await self._admin_request(
            "PATCH",
            f"/api/admin/agents/{self.agent_id}",
            {"composio_toolkits": merged},
        )

    async def remove_toolkit(self, slug: str) -> dict:
        """Remove a toolkit from the agent's composio_toolkits array."""
        result = await self._admin_request("GET", f"/api/admin/agents/{self.agent_id}")
        agent = result.get("agent", {}) if result else {}
        current = agent.get("composio_toolkits", [])

        updated = [t for t in current if t.lower() != slug.lower()]

        return await self._admin_request(
            "PATCH",
            f"/api/admin/agents/{self.agent_id}",
            {"composio_toolkits": updated},
        )

    async def save_api_key(self, toolkit: str, api_key: str) -> dict:
        """Save API key for a toolkit connector."""
        return await self._admin_request(
            "POST",
            f"/api/admin/agents/{self.agent_id}/connectors",
            {"toolkit": toolkit, "api_key": api_key},
        )

    async def initiate_oauth(self, toolkit: str) -> dict:
        """Initiate OAuth flow for a toolkit. Returns { redirect_url }."""
        return await self._admin_request(
            "POST",
            f"/api/admin/agents/{self.agent_id}/connectors/{toolkit}/initiate-oauth",
        )

    # ─── Runs / Activity ─────────────────────────────────────────────────

    async def list_runs(self, limit: int = 50, offset: int = 0, status: str | None = None) -> dict:
        """List runs for the agent."""
        params = f"?limit={limit}&offset={offset}"
        if status:
            params += f"&status={status}"
        result = await self._admin_request("GET", f"/api/admin/runs{params}")
        if not result:
            return {"runs": [], "total": 0}
        # AgentPlane returns {data: [...], limit, offset}; normalize to {runs: [...]}
        return {"runs": result.get("data", []), "total": len(result.get("data", []))}

    async def get_run(self, run_id: str) -> dict:
        """Get run details including transcript.

        The upstream endpoint returns NDJSON: first line is {run, transcript}.
        We parse the first line and return it directly.
        """
        url = f"{self.base_url}/api/admin/runs/{run_id}"
        async with httpx.AsyncClient(timeout=ADMIN_TIMEOUT) as client:
            login_resp = await client.post(
                f"{self.base_url}/api/admin/login",
                json={"password": _get_admin_key()},
            )
            login_resp.raise_for_status()

            response = await client.get(url)
            response.raise_for_status()
            # Parse first line of NDJSON
            first_line = response.text.split("\n", 1)[0]
            data = json.loads(first_line)
            run = data.get("run", {})
            run["transcript"] = data.get("transcript", [])
            return run

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

        async with httpx.AsyncClient(timeout=STREAMING_TIMEOUT) as client:
            async with client.stream("POST", url, headers=headers, json=body) as response:
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
                result = RunResult(
                    output=event.get("data", {}).get("output", ""),
                    session_id=event.get("data", {}).get("session_id"),
                    metadata=event.get("data", {}).get("metadata", {}),
                )
                # Continue draining to keep connection clean

        if result is None:
            raise AgentPlaneError("Stream ended without result event")
        return result

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

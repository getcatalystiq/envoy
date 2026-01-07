"""Maven AI agent client with JWT caching and retry."""

import json
import os
import time
import uuid
from typing import Any, Optional

import boto3
import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

ENVOY_SERVICE_USER = {
    "userId": "envoy-service",
    "email": "envoy@system.internal",
    "name": "Envoy Service",
}


class MavenClient:
    """Client for calling Maven AI agent with caching and retry."""

    _jwt_cache: tuple[str, float] | None = None
    _jwt_ttl: int = 3300  # 55 minutes

    def __init__(self, tenant_id: str, region: str = "us-east-1"):
        self.tenant_id = tenant_id
        self.region = region
        self._secrets = boto3.client("secretsmanager", region_name=region)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=30),
        reraise=True,
    )
    async def invoke_skill(
        self,
        skill_name: str,
        context: dict[str, Any],
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Invoke skill with retry on transient failures."""
        prompt = f"/skill {skill_name}\n\nContext:\n{json.dumps(context, indent=2)}"
        response = await self._invoke(prompt, session_id)
        return self._parse_skill_response(response)

    async def generate_content(
        self,
        target: dict[str, Any],
        content_type: str,
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Generate content for a target."""
        return await self.invoke_skill(
            "envoy-content-email",
            {"target": target, "content_type": content_type},
            session_id,
        )

    async def assess_stage(
        self,
        target: dict[str, Any],
        engagements: list[dict[str, Any]],
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Assess lifecycle stage for a target."""
        return await self.invoke_skill(
            "envoy-stage-assessment",
            {"target": target, "engagements": engagements},
            session_id,
        )

    async def get_optimal_timing(
        self,
        target: dict[str, Any],
        past_sends: list[dict[str, Any]],
        session_id: Optional[str] = None,
    ) -> dict[str, Any]:
        """Get optimal send timing for a target."""
        return await self.invoke_skill(
            "envoy-timing",
            {"target": target, "past_sends": past_sends},
            session_id,
        )

    async def provision_skill(
        self,
        slug: str,
        name: str,
        description: str,
        prompt: str,
    ) -> dict[str, Any]:
        """Create or update a skill in Maven."""
        service_jwt = self._get_service_jwt()
        maven_service_url = os.environ.get("MAVEN_SERVICE_API_URL", "")

        payload = {
            "name": name,
            "slug": slug,
            "description": description,
            "prompt": prompt,
            "enabled": True,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {service_jwt}",
            "X-Service-Id": "envoy-service",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            # Try to create, if exists try to update
            response = await client.post(
                f"{maven_service_url}/api/service/{self.tenant_id}/skills",
                json=payload,
                headers=headers,
            )

            if response.status_code == 409:  # Already exists
                response = await client.put(
                    f"{maven_service_url}/api/service/{self.tenant_id}/skills/{slug}",
                    json=payload,
                    headers=headers,
                )

            response.raise_for_status()
            return response.json()

    async def _invoke(self, prompt: str, session_id: Optional[str] = None) -> str:
        """Invoke Maven with optimized SSE handling."""
        service_jwt = self._get_service_jwt()
        maven_url = os.environ.get("MAVEN_AGENT_URL", "")
        session_id = session_id or str(uuid.uuid4())

        payload = {
            "message": prompt,
            "sessionId": session_id,
            "context": {
                "source": "envoy",
                "isServiceExecution": True,
                "serviceUserId": ENVOY_SERVICE_USER["userId"],
                "serviceTenantId": self.tenant_id,
                "serviceUserEmail": ENVOY_SERVICE_USER["email"],
            },
            "action": "chat",
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {service_jwt}",
        }

        chunks: list[str] = []

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=10, read=300, write=30, pool=10)
        ) as client:
            async with client.stream(
                "POST", maven_url, json=payload, headers=headers
            ) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                        if event.get("type") == "error":
                            raise Exception(event.get("message", "Maven error"))
                        if event.get("type") == "done":
                            break
                        if event.get("type") == "chunk":
                            text = event.get("data", {}).get("text", "")
                            if text:
                                chunks.append(text)
                    except json.JSONDecodeError:
                        continue

        return "".join(chunks)

    def _get_service_jwt(self) -> str:
        """Get JWT with caching to reduce Secrets Manager calls."""
        now = time.time()
        if MavenClient._jwt_cache and now < MavenClient._jwt_cache[1]:
            return MavenClient._jwt_cache[0]

        secret_arn = os.environ.get("MAVEN_SERVICE_JWT_SECRET_ARN", "")
        response = self._secrets.get_secret_value(SecretId=secret_arn)
        jwt_token = response["SecretString"]

        MavenClient._jwt_cache = (jwt_token, now + self._jwt_ttl)
        return jwt_token

    def _parse_skill_response(self, response: str) -> dict[str, Any]:
        """Parse structured JSON response from skill."""
        try:
            if "```json" in response:
                start = response.index("```json") + 7
                end = response.index("```", start)
                return json.loads(response[start:end].strip())
            return json.loads(response)
        except (json.JSONDecodeError, ValueError):
            return {"raw": response}

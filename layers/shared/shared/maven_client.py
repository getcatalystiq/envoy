"""Maven AI agent client with Bedrock AgentCore."""

import asyncio
import json
import os
import uuid
from typing import Any, Optional


class UUIDEncoder(json.JSONEncoder):
    """JSON encoder that handles UUID objects."""

    def default(self, obj):
        if isinstance(obj, uuid.UUID):
            return str(obj)
        return super().default(obj)

import boto3
import httpx
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.config import Config
from tenacity import retry, stop_after_attempt, wait_exponential

ENVOY_SERVICE_ID = "envoy-service"


class MavenClient:
    """Client for calling Maven AI agent via Bedrock AgentCore."""

    def __init__(
        self,
        tenant_id: str,
        service_runtime_arn: str,
        region: str = "us-east-1",
    ):
        if not service_runtime_arn:
            raise ValueError("service_runtime_arn is required")
        self.tenant_id = tenant_id
        self.service_runtime_arn = service_runtime_arn
        self.region = region
        session = boto3.Session()
        self._credentials = session.get_credentials()
        # 5 minute read timeout for long-running Maven operations (e.g., image generation)
        config = Config(read_timeout=300, connect_timeout=10)
        self._agentcore_client = boto3.client("bedrock-agentcore", region_name=region, config=config)

    def _sign_request(self, method: str, url: str, headers: dict, body: str = "") -> dict:
        """Sign request with AWS SigV4 for API Gateway."""
        request = AWSRequest(method=method, url=url, headers=headers, data=body)
        SigV4Auth(self._credentials, "execute-api", self.region).add_auth(request)
        return dict(request.headers)

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
        prompt = f"use skill {skill_name}\n\nContext:\n{json.dumps(context, indent=2, cls=UUIDEncoder)}"
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
            "envoy-content-generation",
            {"target": target, "content_type": content_type},
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
        maven_service_url = os.environ.get("MAVEN_SERVICE_API_URL", "")

        payload = {
            "name": name,
            "slug": slug,
            "description": description,
            "prompt": prompt,
            "enabled": True,
        }

        body = json.dumps(payload, cls=UUIDEncoder)
        base_headers = {
            "Content-Type": "application/json",
            "X-Service-Id": ENVOY_SERVICE_ID,
        }

        create_url = f"{maven_service_url}/api/service/{self.tenant_id}/skills"
        headers = self._sign_request("POST", create_url, base_headers, body)

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(create_url, content=body, headers=headers)

            if response.status_code == 409:  # Already exists
                update_url = f"{maven_service_url}/api/service/{self.tenant_id}/skills/{slug}"
                headers = self._sign_request("PUT", update_url, base_headers, body)
                response = await client.put(update_url, content=body, headers=headers)

            response.raise_for_status()
            return response.json()

    async def _invoke(self, prompt: str, session_id: Optional[str] = None) -> str:
        """Invoke Maven via Bedrock AgentCore."""
        session_id = session_id or str(uuid.uuid4())

        payload = {
            "message": prompt,
            "sessionId": session_id,
            "context": {
                "isServiceExecution": True,
                "serviceUserId": ENVOY_SERVICE_ID,
                "serviceUserEmail": f"{ENVOY_SERVICE_ID}@system",
                "serviceTenantId": self.tenant_id,
                "source": ENVOY_SERVICE_ID,
            },
        }

        def sync_invoke() -> str:
            response = self._agentcore_client.invoke_agent_runtime(
                agentRuntimeArn=self.service_runtime_arn,
                runtimeSessionId=session_id,
                payload=json.dumps(payload, cls=UUIDEncoder).encode("utf-8"),
                qualifier="DEFAULT",
            )

            chunks: list[str] = []
            stream = response.get("response")
            if stream:
                content = stream.read()
                if isinstance(content, bytes):
                    content = content.decode("utf-8")

                for line in content.split("\n"):
                    if not line.startswith("data: "):
                        continue
                    try:
                        event = json.loads(line[6:])
                        event_type = event.get("type")
                        if event_type == "error":
                            error_msg = event.get("data", {}).get("message", "Maven error")
                            raise Exception(error_msg)
                        if event_type == "chunk":
                            text = event.get("data", {}).get("text", "")
                            if text:
                                chunks.append(text)
                    except json.JSONDecodeError:
                        continue

            return "".join(chunks)

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, sync_invoke)

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

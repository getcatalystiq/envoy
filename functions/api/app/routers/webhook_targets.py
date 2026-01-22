"""Webhook router for target ingestion."""

import json
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from shared.database import get_raw_connection
from shared.queries import TargetQueries
from shared.queries.targets import auto_enroll_in_default_sequence
from shared.webhook_auth import verify_webhook_secret

router = APIRouter(prefix="/webhook", tags=["webhook"])


class TargetWebhookPayload(BaseModel):
    """Payload for single target ingestion via webhook."""

    # Matching fields (at least one required)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(None, max_length=20)

    # Target classification (accept names, resolve to UUIDs)
    target_type: Optional[str] = Field(None, max_length=100)
    segment: Optional[str] = Field(None, max_length=100)

    # Standard fields
    first_name: Optional[str] = Field(None, max_length=100)
    last_name: Optional[str] = Field(None, max_length=100)
    company: Optional[str] = Field(None, max_length=255)
    lifecycle_stage: Optional[int] = Field(None, ge=0, le=6)

    # Extensible fields
    custom_fields: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("metadata", "custom_fields", mode="before")
    @classmethod
    def parse_json_fields(cls, v: Any) -> dict:
        """Parse JSON string fields if they arrive as strings, including nested."""

        def parse_recursive(val: Any) -> Any:
            """Recursively parse JSON strings within dicts and lists."""
            if isinstance(val, str):
                if not val.strip():
                    return val
                # Try to parse as JSON if it looks like JSON
                if val.startswith(("{", "[", '"')):
                    try:
                        parsed = json.loads(val)
                        # Recursively parse the result
                        return parse_recursive(parsed)
                    except json.JSONDecodeError:
                        return val
                return val
            elif isinstance(val, dict):
                return {k: parse_recursive(v) for k, v in val.items()}
            elif isinstance(val, list):
                return [parse_recursive(item) for item in val]
            return val

        if v is None:
            return {}
        result = parse_recursive(v)
        return result if isinstance(result, dict) else {}

    @model_validator(mode="after")
    def at_least_one_identifier(self) -> "TargetWebhookPayload":
        if not self.email and not self.phone:
            raise ValueError("At least one of email or phone is required")
        return self


class TargetWebhookResponse(BaseModel):
    """Response for single target ingestion."""

    id: UUID
    action: str  # "created" or "updated"
    matched_on: Optional[str] = None  # "email" or "phone" or None


class BulkTargetWebhookPayload(BaseModel):
    """Payload for bulk target ingestion."""

    targets: list[TargetWebhookPayload] = Field(..., max_length=100)


class BulkTargetWebhookResponse(BaseModel):
    """Response for bulk target ingestion."""

    created: int
    updated: int
    errors: list[dict[str, Any]]


async def resolve_target_type(
    conn,
    org_id: str,
    target_type_name: Optional[str],
) -> Optional[UUID]:
    """Resolve target type name to UUID (case-insensitive)."""
    if not target_type_name:
        return None

    result = await conn.fetchrow(
        """
        SELECT id FROM target_types
        WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
        """,
        org_id,
        target_type_name,
    )
    return result["id"] if result else None


async def resolve_segment(
    conn,
    org_id: str,
    segment_name: Optional[str],
) -> Optional[UUID]:
    """Resolve segment name to UUID (case-insensitive)."""
    if not segment_name:
        return None

    result = await conn.fetchrow(
        """
        SELECT id FROM segments
        WHERE organization_id = $1 AND LOWER(name) = LOWER($2)
        """,
        org_id,
        segment_name,
    )
    return result["id"] if result else None


@router.post("/targets", response_model=TargetWebhookResponse)
async def ingest_target(
    payload: TargetWebhookPayload,
    x_organization_id: UUID = Header(..., alias="X-Organization-Id"),
    x_webhook_secret: str = Header(..., alias="X-Webhook-Secret"),
) -> TargetWebhookResponse:
    """
    Ingest a single target via webhook.

    Matches on email first, then phone. Updates if found, creates if not.

    Headers required:
    - X-Organization-Id: Organization UUID
    - X-Webhook-Secret: Organization's webhook secret

    Body:
    - email or phone required (at least one)
    - target_type and segment can be names (resolved to UUIDs)
    - All other fields optional
    """
    # Verify webhook secret
    await verify_webhook_secret(x_organization_id, x_webhook_secret)

    org_id = str(x_organization_id)

    async with get_raw_connection() as conn:
        # Resolve target_type and segment names to UUIDs
        target_type_id = await resolve_target_type(conn, org_id, payload.target_type)
        segment_id = await resolve_segment(conn, org_id, payload.segment)

        # Upsert target
        target, action, matched_on = await TargetQueries.upsert(
            conn,
            org_id=org_id,
            email=payload.email,
            phone=payload.phone,
            first_name=payload.first_name,
            last_name=payload.last_name,
            company=payload.company,
            target_type_id=target_type_id,
            segment_id=segment_id,
            lifecycle_stage=payload.lifecycle_stage,
            custom_fields=payload.custom_fields,
            metadata=payload.metadata,
        )

        # Auto-enroll in default sequence only for newly created targets
        if action == "created" and target_type_id:
            await auto_enroll_in_default_sequence(
                conn, org_id, target["id"], target_type_id
            )

    status_code = 201 if action == "created" else 200
    return TargetWebhookResponse(
        id=target["id"],
        action=action,
        matched_on=matched_on,
    )


@router.post("/targets/bulk", response_model=BulkTargetWebhookResponse)
async def ingest_targets_bulk(
    payload: BulkTargetWebhookPayload,
    x_organization_id: UUID = Header(..., alias="X-Organization-Id"),
    x_webhook_secret: str = Header(..., alias="X-Webhook-Secret"),
) -> BulkTargetWebhookResponse:
    """
    Bulk ingest up to 100 targets via webhook.

    Each target is processed individually with the same matching logic
    as the single target endpoint.
    """
    # Verify webhook secret
    await verify_webhook_secret(x_organization_id, x_webhook_secret)

    org_id = str(x_organization_id)
    created = 0
    updated = 0
    errors: list[dict[str, Any]] = []

    async with get_raw_connection() as conn:
        for i, target_data in enumerate(payload.targets):
            try:
                # Resolve target_type and segment names to UUIDs
                target_type_id = await resolve_target_type(
                    conn, org_id, target_data.target_type
                )
                segment_id = await resolve_segment(
                    conn, org_id, target_data.segment
                )

                # Upsert target
                target, action, _ = await TargetQueries.upsert(
                    conn,
                    org_id=org_id,
                    email=target_data.email,
                    phone=target_data.phone,
                    first_name=target_data.first_name,
                    last_name=target_data.last_name,
                    company=target_data.company,
                    target_type_id=target_type_id,
                    segment_id=segment_id,
                    lifecycle_stage=target_data.lifecycle_stage,
                    custom_fields=target_data.custom_fields,
                    metadata=target_data.metadata,
                )

                # Auto-enroll in default sequence only for newly created targets
                if action == "created" and target_type_id:
                    await auto_enroll_in_default_sequence(
                        conn, org_id, target["id"], target_type_id
                    )

                if action == "created":
                    created += 1
                else:
                    updated += 1

            except Exception as e:
                errors.append({
                    "index": i,
                    "email": target_data.email,
                    "phone": target_data.phone,
                    "error": str(e),
                })

    return BulkTargetWebhookResponse(
        created=created,
        updated=updated,
        errors=errors,
    )

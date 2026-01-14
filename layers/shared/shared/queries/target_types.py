"""Target type database queries."""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

import asyncpg


class TargetTypeQueries:
    """Database queries for target types."""

    @staticmethod
    def _parse_json_fields(row: dict[str, Any]) -> dict[str, Any]:
        """Parse JSON string fields back to dicts/lists."""
        if row.get("lifecycle_stages") and isinstance(row["lifecycle_stages"], str):
            row["lifecycle_stages"] = json.loads(row["lifecycle_stages"])
        return row

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: UUID,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List all target types for an organization."""
        rows = await conn.fetch(
            """
            SELECT id, organization_id, name, description, lifecycle_stages, created_at
            FROM target_types
            WHERE organization_id = $1
            ORDER BY name ASC
            LIMIT $2 OFFSET $3
            """,
            org_id,
            limit,
            offset,
        )
        return [TargetTypeQueries._parse_json_fields(dict(row)) for row in rows]

    @staticmethod
    async def get(
        conn: asyncpg.Connection,
        type_id: UUID,
        org_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get a single target type."""
        row = await conn.fetchrow(
            """
            SELECT id, organization_id, name, description, lifecycle_stages, created_at
            FROM target_types
            WHERE id = $1 AND organization_id = $2
            """,
            type_id,
            org_id,
        )
        if not row:
            return None
        return TargetTypeQueries._parse_json_fields(dict(row))

    @staticmethod
    async def get_by_name(
        conn: asyncpg.Connection,
        org_id: UUID,
        name: str,
    ) -> Optional[dict[str, Any]]:
        """Get a target type by name within an organization."""
        row = await conn.fetchrow(
            """
            SELECT id, organization_id, name, description, lifecycle_stages, created_at
            FROM target_types
            WHERE organization_id = $1 AND name = $2
            """,
            org_id,
            name,
        )
        if not row:
            return None
        return TargetTypeQueries._parse_json_fields(dict(row))

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: UUID,
        name: str,
        description: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a new target type with default lifecycle stages."""
        row = await conn.fetchrow(
            """
            INSERT INTO target_types (organization_id, name, description)
            VALUES ($1, $2, $3)
            RETURNING id, organization_id, name, description, lifecycle_stages, created_at
            """,
            org_id,
            name,
            description,
        )
        return TargetTypeQueries._parse_json_fields(dict(row))

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        type_id: UUID,
        org_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Update a target type."""
        updates = []
        params: list[Any] = []
        param_idx = 1

        if name is not None:
            updates.append(f"name = ${param_idx}")
            params.append(name)
            param_idx += 1
        if description is not None:
            updates.append(f"description = ${param_idx}")
            params.append(description)
            param_idx += 1

        if not updates:
            return await TargetTypeQueries.get(conn, type_id, org_id)

        params.extend([type_id, org_id])
        query = f"""
            UPDATE target_types
            SET {', '.join(updates)}
            WHERE id = ${param_idx} AND organization_id = ${param_idx + 1}
            RETURNING id, organization_id, name, description, lifecycle_stages, created_at
        """
        row = await conn.fetchrow(query, *params)
        if not row:
            return None
        return TargetTypeQueries._parse_json_fields(dict(row))

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        type_id: UUID,
        org_id: UUID,
    ) -> bool:
        """Delete a target type (hard delete)."""
        result = await conn.execute(
            "DELETE FROM target_types WHERE id = $1 AND organization_id = $2",
            type_id,
            org_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_usage_count(
        conn: asyncpg.Connection,
        type_id: UUID,
    ) -> dict[str, int]:
        """Count how many entities reference this target type."""
        # Count segments (will cascade delete)
        segments_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM segments WHERE target_type_id = $1",
            type_id,
        )
        segments_count = segments_row["count"] if segments_row else 0

        # Count targets (will set to NULL)
        targets_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM targets WHERE target_type_id = $1",
            type_id,
        )
        targets_count = targets_row["count"] if targets_row else 0

        # Count sequences (will RESTRICT delete)
        sequences_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM sequences WHERE target_type_id = $1",
            type_id,
        )
        sequences_count = sequences_row["count"] if sequences_row else 0

        # Count content (will set to NULL)
        content_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM content WHERE target_type_id = $1",
            type_id,
        )
        content_count = content_row["count"] if content_row else 0

        return {
            "segments": segments_count,
            "targets": targets_count,
            "sequences": sequences_count,
            "content": content_count,
        }

"""Segment database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg


class SegmentQueries:
    """Database queries for segments."""

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: UUID,
        target_type_id: Optional[UUID] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List all segments for an organization, optionally filtered by target type."""
        if target_type_id:
            rows = await conn.fetch(
                """
                SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
                       s.pain_points, s.objections, s.created_at,
                       t.name as target_type_name
                FROM segments s
                LEFT JOIN target_types t ON s.target_type_id = t.id
                WHERE s.organization_id = $1 AND s.target_type_id = $2
                ORDER BY s.name ASC
                LIMIT $3 OFFSET $4
                """,
                org_id,
                target_type_id,
                limit,
                offset,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
                       s.pain_points, s.objections, s.created_at,
                       t.name as target_type_name
                FROM segments s
                LEFT JOIN target_types t ON s.target_type_id = t.id
                WHERE s.organization_id = $1
                ORDER BY s.name ASC
                LIMIT $2 OFFSET $3
                """,
                org_id,
                limit,
                offset,
            )
        return [SegmentQueries._parse_arrays(dict(row)) for row in rows]

    @staticmethod
    def _parse_arrays(row: dict[str, Any]) -> dict[str, Any]:
        """Convert None arrays to empty lists."""
        if row.get("pain_points") is None:
            row["pain_points"] = []
        if row.get("objections") is None:
            row["objections"] = []
        return row

    @staticmethod
    async def get(
        conn: asyncpg.Connection,
        segment_id: UUID,
        org_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get a single segment."""
        row = await conn.fetchrow(
            """
            SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
                   s.pain_points, s.objections, s.created_at,
                   t.name as target_type_name
            FROM segments s
            LEFT JOIN target_types t ON s.target_type_id = t.id
            WHERE s.id = $1 AND s.organization_id = $2
            """,
            segment_id,
            org_id,
        )
        if not row:
            return None
        return SegmentQueries._parse_arrays(dict(row))

    @staticmethod
    async def get_by_name(
        conn: asyncpg.Connection,
        target_type_id: UUID,
        name: str,
    ) -> Optional[dict[str, Any]]:
        """Get a segment by name within a target type."""
        row = await conn.fetchrow(
            """
            SELECT s.id, s.organization_id, s.target_type_id, s.name, s.description,
                   s.pain_points, s.objections, s.created_at,
                   t.name as target_type_name
            FROM segments s
            LEFT JOIN target_types t ON s.target_type_id = t.id
            WHERE s.target_type_id = $1 AND s.name = $2
            """,
            target_type_id,
            name,
        )
        if not row:
            return None
        return SegmentQueries._parse_arrays(dict(row))

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: UUID,
        target_type_id: UUID,
        name: str,
        description: Optional[str] = None,
        pain_points: Optional[list[str]] = None,
        objections: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Create a new segment."""
        row = await conn.fetchrow(
            """
            INSERT INTO segments (organization_id, target_type_id, name, description, pain_points, objections)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, organization_id, target_type_id, name, description, pain_points, objections, created_at
            """,
            org_id,
            target_type_id,
            name,
            description,
            pain_points or [],
            objections or [],
        )
        result = SegmentQueries._parse_arrays(dict(row))

        # Fetch target type name
        target_type = await conn.fetchrow(
            "SELECT name FROM target_types WHERE id = $1",
            target_type_id,
        )
        result["target_type_name"] = target_type["name"] if target_type else None

        return result

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        segment_id: UUID,
        org_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        pain_points: Optional[list[str]] = None,
        objections: Optional[list[str]] = None,
    ) -> Optional[dict[str, Any]]:
        """Update a segment."""
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
        if target_type_id is not None:
            updates.append(f"target_type_id = ${param_idx}")
            params.append(target_type_id)
            param_idx += 1
        if pain_points is not None:
            updates.append(f"pain_points = ${param_idx}")
            params.append(pain_points)
            param_idx += 1
        if objections is not None:
            updates.append(f"objections = ${param_idx}")
            params.append(objections)
            param_idx += 1

        if not updates:
            return await SegmentQueries.get(conn, segment_id, org_id)

        params.extend([segment_id, org_id])
        query = f"""
            UPDATE segments
            SET {', '.join(updates)}
            WHERE id = ${param_idx} AND organization_id = ${param_idx + 1}
            RETURNING id, organization_id, target_type_id, name, description, pain_points, objections, created_at
        """
        row = await conn.fetchrow(query, *params)
        if not row:
            return None

        result = SegmentQueries._parse_arrays(dict(row))

        # Fetch target type name
        target_type = await conn.fetchrow(
            "SELECT name FROM target_types WHERE id = $1",
            result["target_type_id"],
        )
        result["target_type_name"] = target_type["name"] if target_type else None

        return result

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        segment_id: UUID,
        org_id: UUID,
    ) -> bool:
        """Delete a segment (hard delete)."""
        result = await conn.execute(
            "DELETE FROM segments WHERE id = $1 AND organization_id = $2",
            segment_id,
            org_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_usage_count(
        conn: asyncpg.Connection,
        segment_id: UUID,
    ) -> dict[str, int]:
        """Count how many entities reference this segment."""
        # Count targets (will set to NULL)
        targets_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM targets WHERE segment_id = $1",
            segment_id,
        )
        targets_count = targets_row["count"] if targets_row else 0

        # Count content (will set to NULL)
        content_row = await conn.fetchrow(
            "SELECT COUNT(*) FROM content WHERE segment_id = $1",
            segment_id,
        )
        content_count = content_row["count"] if content_row else 0

        return {
            "targets": targets_count,
            "content": content_count,
        }

    @staticmethod
    async def count_by_target_type(
        conn: asyncpg.Connection,
        target_type_id: UUID,
    ) -> int:
        """Count segments for a target type."""
        row = await conn.fetchrow(
            "SELECT COUNT(*) FROM segments WHERE target_type_id = $1",
            target_type_id,
        )
        return row["count"] if row else 0

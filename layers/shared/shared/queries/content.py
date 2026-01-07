"""Content-related database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg


class ContentQueries:
    """Database queries for content."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: str,
        name: str,
        content_type: str,
        body: str,
        channel: str = "email",
        subject: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: Optional[int] = None,
        status: str = "draft",
    ) -> dict[str, Any]:
        """Create new content."""
        row = await conn.fetchrow(
            """
            INSERT INTO content (
                organization_id, name, content_type, channel, subject, body,
                target_type_id, segment_id, lifecycle_stage, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
            """,
            org_id,
            name,
            content_type,
            channel,
            subject,
            body,
            target_type_id,
            segment_id,
            lifecycle_stage,
            status,
        )
        return dict(row)

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        content_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get content by ID."""
        row = await conn.fetchrow(
            "SELECT * FROM content WHERE id = $1",
            content_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: str,
        content_type: Optional[str] = None,
        channel: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: Optional[int] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List content with optional filters."""
        conditions = ["organization_id = $1"]
        params: list[Any] = [org_id]
        param_idx = 2

        if content_type:
            conditions.append(f"content_type = ${param_idx}")
            params.append(content_type)
            param_idx += 1

        if channel:
            conditions.append(f"channel = ${param_idx}")
            params.append(channel)
            param_idx += 1

        if target_type_id:
            conditions.append(f"target_type_id = ${param_idx}")
            params.append(target_type_id)
            param_idx += 1

        if segment_id:
            conditions.append(f"segment_id = ${param_idx}")
            params.append(segment_id)
            param_idx += 1

        if lifecycle_stage is not None:
            conditions.append(f"lifecycle_stage = ${param_idx}")
            params.append(lifecycle_stage)
            param_idx += 1

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
            param_idx += 1

        where_clause = " AND ".join(conditions)
        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT * FROM content
            WHERE {where_clause}
            ORDER BY created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        content_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update content fields."""
        if not fields:
            return await ContentQueries.get_by_id(conn, content_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            if value is not None:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return await ContentQueries.get_by_id(conn, content_id)

        set_clauses.append("updated_at = NOW()")
        params.append(content_id)

        row = await conn.fetchrow(
            f"""
            UPDATE content
            SET {", ".join(set_clauses)}
            WHERE id = ${param_idx}
            RETURNING *
            """,
            *params,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        content_id: UUID,
    ) -> bool:
        """Delete content."""
        result = await conn.execute(
            "DELETE FROM content WHERE id = $1",
            content_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def find_best_match(
        conn: asyncpg.Connection,
        org_id: str,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: Optional[int] = None,
        content_type: Optional[str] = None,
        channel: str = "email",
    ) -> Optional[dict[str, Any]]:
        """Find best matching content for targeting criteria."""
        # Priority: exact match > partial match > any active content
        row = await conn.fetchrow(
            """
            SELECT * FROM content
            WHERE organization_id = $1
              AND channel = $2
              AND status = 'active'
              AND (target_type_id IS NULL OR target_type_id = $3)
              AND (segment_id IS NULL OR segment_id = $4)
              AND (lifecycle_stage IS NULL OR lifecycle_stage = $5)
              AND ($6::text IS NULL OR content_type = $6)
            ORDER BY
                (target_type_id = $3)::int +
                (segment_id = $4)::int +
                (lifecycle_stage = $5)::int DESC,
                created_at DESC
            LIMIT 1
            """,
            org_id,
            channel,
            target_type_id,
            segment_id,
            lifecycle_stage,
            content_type,
        )
        return dict(row) if row else None

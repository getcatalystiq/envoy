"""Target-related database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg


class TargetQueries:
    """Database queries for targets."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: str,
        email: str,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        company: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: int = 0,
        custom_fields: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Create a new target."""
        row = await conn.fetchrow(
            """
            INSERT INTO targets (
                organization_id, email, first_name, last_name, company,
                target_type_id, segment_id, lifecycle_stage, custom_fields
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING *
            """,
            org_id,
            email,
            first_name,
            last_name,
            company,
            target_type_id,
            segment_id,
            lifecycle_stage,
            custom_fields or {},
        )
        return dict(row)

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        target_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get target by ID."""
        row = await conn.fetchrow(
            "SELECT * FROM targets WHERE id = $1",
            target_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_by_email(
        conn: asyncpg.Connection,
        org_id: str,
        email: str,
    ) -> Optional[dict[str, Any]]:
        """Get target by email within organization."""
        row = await conn.fetchrow(
            "SELECT * FROM targets WHERE organization_id = $1 AND email = $2",
            org_id,
            email,
        )
        return dict(row) if row else None

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: Optional[int] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List targets with optional filters."""
        conditions = ["organization_id = $1"]
        params: list[Any] = [org_id]
        param_idx = 2

        if status:
            conditions.append(f"status = ${param_idx}")
            params.append(status)
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

        where_clause = " AND ".join(conditions)
        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT * FROM targets
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
        target_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update target fields."""
        if not fields:
            return await TargetQueries.get_by_id(conn, target_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            if value is not None:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return await TargetQueries.get_by_id(conn, target_id)

        set_clauses.append("updated_at = NOW()")
        params.append(target_id)

        row = await conn.fetchrow(
            f"""
            UPDATE targets
            SET {", ".join(set_clauses)}
            WHERE id = ${param_idx}
            RETURNING *
            """,
            *params,
        )
        return dict(row) if row else None

    @staticmethod
    async def update_status(
        conn: asyncpg.Connection,
        email: str,
        status: str,
    ) -> int:
        """Update target status by email across all orgs (for bounces)."""
        result = await conn.execute(
            """
            UPDATE targets
            SET status = $1, updated_at = NOW()
            WHERE email = $2 AND status = 'active'
            """,
            status,
            email,
        )
        return int(result.split()[-1])

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        target_id: UUID,
    ) -> bool:
        """Delete a target."""
        result = await conn.execute(
            "DELETE FROM targets WHERE id = $1",
            target_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def count(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
    ) -> int:
        """Count targets in organization."""
        if status:
            row = await conn.fetchrow(
                "SELECT COUNT(*) FROM targets WHERE organization_id = $1 AND status = $2",
                org_id,
                status,
            )
        else:
            row = await conn.fetchrow(
                "SELECT COUNT(*) FROM targets WHERE organization_id = $1",
                org_id,
            )
        return row["count"] if row else 0

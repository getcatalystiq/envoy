"""Campaign-related database queries."""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

import asyncpg


class CampaignQueries:
    """Database queries for campaigns."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: str,
        name: str,
        target_criteria: Optional[dict[str, Any]] = None,
        skills: Optional[dict[str, Any]] = None,
        scheduled_at: Optional[str] = None,
        settings: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Create a new campaign."""
        row = await conn.fetchrow(
            """
            INSERT INTO campaigns (
                organization_id, name, target_criteria, skills,
                scheduled_at, settings
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            org_id,
            name,
            json.dumps(target_criteria or {}),
            json.dumps(skills or {}),
            scheduled_at,
            json.dumps(settings or {}),
        )
        return dict(row)

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        campaign_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get campaign by ID with content."""
        row = await conn.fetchrow(
            """
            SELECT c.*,
                COALESCE(
                    json_agg(
                        json_build_object('id', ct.id, 'name', ct.name, 'position', cc.position)
                        ORDER BY cc.position
                    ) FILTER (WHERE ct.id IS NOT NULL),
                    '[]'
                ) as content_items
            FROM campaigns c
            LEFT JOIN campaign_content cc ON cc.campaign_id = c.id
            LEFT JOIN content ct ON ct.id = cc.content_id
            WHERE c.id = $1
            GROUP BY c.id
            """,
            campaign_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List campaigns with optional status filter."""
        if status:
            rows = await conn.fetch(
                """
                SELECT * FROM campaigns
                WHERE organization_id = $1 AND status = $2
                ORDER BY created_at DESC
                LIMIT $3 OFFSET $4
                """,
                org_id,
                status,
                limit,
                offset,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT * FROM campaigns
                WHERE organization_id = $1
                ORDER BY created_at DESC
                LIMIT $2 OFFSET $3
                """,
                org_id,
                limit,
                offset,
            )
        return [dict(row) for row in rows]

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        campaign_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update campaign fields."""
        if not fields:
            return await CampaignQueries.get_by_id(conn, campaign_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            if value is not None:
                if key in ("target_criteria", "skills", "settings", "stats"):
                    value = json.dumps(value)
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return await CampaignQueries.get_by_id(conn, campaign_id)

        set_clauses.append("updated_at = NOW()")
        params.append(campaign_id)

        row = await conn.fetchrow(
            f"""
            UPDATE campaigns
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
        campaign_id: UUID,
        status: str,
        **extra_fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update campaign status with optional extra fields."""
        return await CampaignQueries.update(conn, campaign_id, status=status, **extra_fields)

    @staticmethod
    async def add_content(
        conn: asyncpg.Connection,
        campaign_id: UUID,
        content_id: UUID,
        position: int = 0,
    ) -> bool:
        """Add content to campaign."""
        try:
            await conn.execute(
                """
                INSERT INTO campaign_content (campaign_id, content_id, position)
                VALUES ($1, $2, $3)
                ON CONFLICT (campaign_id, content_id) DO UPDATE SET position = $3
                """,
                campaign_id,
                content_id,
                position,
            )
            return True
        except Exception:
            return False

    @staticmethod
    async def remove_content(
        conn: asyncpg.Connection,
        campaign_id: UUID,
        content_id: UUID,
    ) -> bool:
        """Remove content from campaign."""
        result = await conn.execute(
            "DELETE FROM campaign_content WHERE campaign_id = $1 AND content_id = $2",
            campaign_id,
            content_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        campaign_id: UUID,
    ) -> bool:
        """Delete a campaign."""
        result = await conn.execute(
            "DELETE FROM campaigns WHERE id = $1",
            campaign_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_scheduled_campaigns(
        conn: asyncpg.Connection,
    ) -> list[dict[str, Any]]:
        """Get campaigns scheduled to run now."""
        rows = await conn.fetch(
            """
            SELECT * FROM campaigns
            WHERE status = 'scheduled'
              AND scheduled_at <= NOW()
            ORDER BY scheduled_at ASC
            """
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def update_stats(
        conn: asyncpg.Connection,
        campaign_id: UUID,
        stats: dict[str, Any],
    ) -> None:
        """Update campaign statistics."""
        await conn.execute(
            """
            UPDATE campaigns
            SET stats = stats || $1::jsonb, updated_at = NOW()
            WHERE id = $2
            """,
            json.dumps(stats),
            campaign_id,
        )

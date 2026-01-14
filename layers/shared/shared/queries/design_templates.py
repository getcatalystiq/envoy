"""Design template database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg


class DesignTemplateQueries:
    """Database queries for design templates."""

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: UUID,
        include_archived: bool = False,
    ) -> list[dict[str, Any]]:
        """List all design templates for an organization."""
        query = """
            SELECT id, organization_id, name, description, mjml_source,
                   html_compiled, archived, created_at, updated_at
            FROM design_templates
            WHERE organization_id = $1
        """
        if not include_archived:
            query += " AND archived = FALSE"
        query += " ORDER BY created_at DESC"

        rows = await conn.fetch(query, org_id)
        return [dict(row) for row in rows]

    @staticmethod
    async def get(
        conn: asyncpg.Connection,
        template_id: UUID,
        org_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get a single design template."""
        row = await conn.fetchrow(
            """
            SELECT id, organization_id, name, description, mjml_source,
                   html_compiled, archived, created_at, updated_at
            FROM design_templates
            WHERE id = $1 AND organization_id = $2
            """,
            template_id,
            org_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: UUID,
        name: str,
        mjml_source: str,
        html_compiled: str,
        description: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a new design template."""
        row = await conn.fetchrow(
            """
            INSERT INTO design_templates (organization_id, name, description, mjml_source, html_compiled)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, organization_id, name, description, mjml_source,
                      html_compiled, archived, created_at, updated_at
            """,
            org_id,
            name,
            description,
            mjml_source,
            html_compiled,
        )
        return dict(row)

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        template_id: UUID,
        org_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        mjml_source: Optional[str] = None,
        html_compiled: Optional[str] = None,
        archived: Optional[bool] = None,
    ) -> Optional[dict[str, Any]]:
        """Update a design template."""
        # Build dynamic update
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
        if mjml_source is not None:
            updates.append(f"mjml_source = ${param_idx}")
            params.append(mjml_source)
            param_idx += 1
        if html_compiled is not None:
            updates.append(f"html_compiled = ${param_idx}")
            params.append(html_compiled)
            param_idx += 1
        if archived is not None:
            updates.append(f"archived = ${param_idx}")
            params.append(archived)
            param_idx += 1

        if not updates:
            return await DesignTemplateQueries.get(conn, template_id, org_id)

        params.extend([template_id, org_id])
        query = f"""
            UPDATE design_templates
            SET {', '.join(updates)}
            WHERE id = ${param_idx} AND organization_id = ${param_idx + 1}
            RETURNING id, organization_id, name, description, mjml_source,
                      html_compiled, archived, created_at, updated_at
        """
        row = await conn.fetchrow(query, *params)
        return dict(row) if row else None

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        template_id: UUID,
        org_id: UUID,
    ) -> bool:
        """Delete a design template (hard delete)."""
        result = await conn.execute(
            "DELETE FROM design_templates WHERE id = $1 AND organization_id = $2",
            template_id,
            org_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_usage_count(
        conn: asyncpg.Connection,
        template_id: UUID,
    ) -> int:
        """Count how many content items use this template."""
        row = await conn.fetchrow(
            "SELECT COUNT(*) FROM content WHERE design_template_id = $1",
            template_id,
        )
        return row["count"] if row else 0

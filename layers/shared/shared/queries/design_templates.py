"""Design template database queries."""

from __future__ import annotations

import json
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
            SELECT id, organization_id, name, description,
                   builder_content, html_compiled, archived,
                   created_at, updated_at
            FROM design_templates
            WHERE organization_id = $1
        """
        if not include_archived:
            query += " AND archived = FALSE"
        query += " ORDER BY created_at DESC"

        rows = await conn.fetch(query, org_id)
        results = []
        for row in rows:
            d = dict(row)
            # Parse JSONB builder_content if present
            if d.get("builder_content") and isinstance(d["builder_content"], str):
                d["builder_content"] = json.loads(d["builder_content"])
            results.append(d)
        return results

    @staticmethod
    async def get(
        conn: asyncpg.Connection,
        template_id: UUID,
        org_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get a single design template."""
        row = await conn.fetchrow(
            """
            SELECT id, organization_id, name, description,
                   builder_content, html_compiled, archived,
                   created_at, updated_at
            FROM design_templates
            WHERE id = $1 AND organization_id = $2
            """,
            template_id,
            org_id,
        )
        if not row:
            return None
        d = dict(row)
        # Parse JSONB builder_content if present
        if d.get("builder_content") and isinstance(d["builder_content"], str):
            d["builder_content"] = json.loads(d["builder_content"])
        return d

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: UUID,
        name: str,
        builder_content: Optional[dict] = None,
        html_compiled: Optional[str] = None,
        description: Optional[str] = None,
    ) -> dict[str, Any]:
        """Create a new design template."""
        # Serialize builder_content to JSON string for JSONB storage
        builder_json = json.dumps(builder_content) if builder_content else None

        row = await conn.fetchrow(
            """
            INSERT INTO design_templates (
                organization_id, name, description,
                builder_content, html_compiled
            )
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, organization_id, name, description,
                      builder_content, html_compiled, archived,
                      created_at, updated_at
            """,
            org_id,
            name,
            description,
            builder_json,
            html_compiled,
        )
        d = dict(row)
        if d.get("builder_content") and isinstance(d["builder_content"], str):
            d["builder_content"] = json.loads(d["builder_content"])
        return d

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        template_id: UUID,
        org_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        builder_content: Optional[dict] = None,
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
        if builder_content is not None:
            updates.append(f"builder_content = ${param_idx}")
            params.append(json.dumps(builder_content))
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
            RETURNING id, organization_id, name, description,
                      builder_content, html_compiled, archived,
                      created_at, updated_at
        """
        row = await conn.fetchrow(query, *params)
        if not row:
            return None
        d = dict(row)
        if d.get("builder_content") and isinstance(d["builder_content"], str):
            d["builder_content"] = json.loads(d["builder_content"])
        return d

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

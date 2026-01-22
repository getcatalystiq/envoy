"""Database queries for graduation rules and events."""

import json
from typing import Any, Optional
from uuid import UUID

import asyncpg


class GraduationQueries:
    """Query class for graduation operations."""

    @staticmethod
    async def list_rules(
        conn: asyncpg.Connection,
        org_id: str,
        source_target_type_id: Optional[UUID] = None,
        enabled: Optional[bool] = None,
    ) -> list[dict[str, Any]]:
        """List graduation rules for an organization."""
        query = """
            SELECT gr.*,
                   st.name as source_type_name,
                   dt.name as destination_type_name
            FROM graduation_rules gr
            JOIN target_types st ON st.id = gr.source_target_type_id
            JOIN target_types dt ON dt.id = gr.destination_target_type_id
            WHERE gr.organization_id = $1
        """
        params: list[Any] = [org_id]

        if source_target_type_id:
            query += f" AND gr.source_target_type_id = ${len(params) + 1}"
            params.append(source_target_type_id)

        if enabled is not None:
            query += f" AND gr.enabled = ${len(params) + 1}"
            params.append(enabled)

        query += " ORDER BY gr.created_at"

        rows = await conn.fetch(query, *params)
        return [GraduationQueries._parse_row(r) for r in rows]

    @staticmethod
    def _parse_row(row: asyncpg.Record) -> dict[str, Any]:
        """Parse a database row, handling JSONB fields."""
        result = dict(row)
        if result.get("conditions") and isinstance(result["conditions"], str):
            result["conditions"] = json.loads(result["conditions"])
        return result

    @staticmethod
    async def get_rule(
        conn: asyncpg.Connection,
        org_id: str,
        rule_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get a single graduation rule."""
        row = await conn.fetchrow(
            """
            SELECT gr.*,
                   st.name as source_type_name,
                   dt.name as destination_type_name
            FROM graduation_rules gr
            JOIN target_types st ON st.id = gr.source_target_type_id
            JOIN target_types dt ON dt.id = gr.destination_target_type_id
            WHERE gr.id = $1 AND gr.organization_id = $2
            """,
            rule_id,
            org_id,
        )
        return GraduationQueries._parse_row(row) if row else None

    @staticmethod
    async def create_rule(
        conn: asyncpg.Connection,
        org_id: str,
        source_target_type_id: UUID,
        destination_target_type_id: UUID,
        name: str,
        conditions: list[dict[str, Any]],
        description: Optional[str] = None,
        enabled: bool = True,
    ) -> dict[str, Any]:
        """Create a new graduation rule."""
        row = await conn.fetchrow(
            """
            INSERT INTO graduation_rules
                (organization_id, source_target_type_id, destination_target_type_id,
                 name, description, conditions, enabled)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            RETURNING *
            """,
            org_id,
            source_target_type_id,
            destination_target_type_id,
            name,
            description,
            json.dumps(conditions),
            enabled,
        )
        return GraduationQueries._parse_row(row)

    @staticmethod
    async def update_rule(
        conn: asyncpg.Connection,
        org_id: str,
        rule_id: UUID,
        **updates: Any,
    ) -> Optional[dict[str, Any]]:
        """Update a graduation rule."""
        if not updates:
            return await GraduationQueries.get_rule(conn, org_id, rule_id)

        set_clauses = []
        params: list[Any] = [rule_id, org_id]

        for key, value in updates.items():
            if key == "conditions":
                set_clauses.append(f"{key} = ${len(params) + 1}::jsonb")
                params.append(json.dumps(value))
            else:
                set_clauses.append(f"{key} = ${len(params) + 1}")
                params.append(value)

        query = f"""
            UPDATE graduation_rules
            SET {", ".join(set_clauses)}
            WHERE id = $1 AND organization_id = $2
            RETURNING *
        """

        rows = await conn.fetch(query, *params)
        return GraduationQueries._parse_row(rows[0]) if rows else None

    @staticmethod
    async def delete_rule(
        conn: asyncpg.Connection,
        org_id: str,
        rule_id: UUID,
    ) -> bool:
        """Delete a graduation rule."""
        result = await conn.execute(
            "DELETE FROM graduation_rules WHERE id = $1 AND organization_id = $2",
            rule_id,
            org_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_rules_for_target_type(
        conn: asyncpg.Connection,
        org_id: str,
        target_type_id: UUID,
    ) -> list[dict[str, Any]]:
        """Get enabled rules for a target type, ordered by creation."""
        rows = await conn.fetch(
            """
            SELECT * FROM graduation_rules
            WHERE organization_id = $1
              AND source_target_type_id = $2
              AND enabled = TRUE
            ORDER BY created_at
            """,
            org_id,
            target_type_id,
        )
        return [GraduationQueries._parse_row(r) for r in rows]

    @staticmethod
    async def record_graduation(
        conn: asyncpg.Connection,
        org_id: str,
        target_id: UUID,
        source_target_type_id: UUID,
        destination_target_type_id: UUID,
        rule_id: Optional[UUID] = None,
        manual: bool = False,
        triggered_by_user_id: Optional[UUID] = None,
    ) -> dict[str, Any]:
        """Record a graduation event."""
        row = await conn.fetchrow(
            """
            INSERT INTO graduation_events
                (organization_id, target_id, rule_id, source_target_type_id,
                 destination_target_type_id, manual, triggered_by_user_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            org_id,
            target_id,
            rule_id,
            source_target_type_id,
            destination_target_type_id,
            manual,
            triggered_by_user_id,
        )
        return dict(row)

    @staticmethod
    async def check_for_cycle(
        conn: asyncpg.Connection,
        org_id: str,
        source_type_id: UUID,
        destination_type_id: UUID,
        exclude_rule_id: Optional[UUID] = None,
    ) -> bool:
        """Check if adding this rule would create a cycle.

        Uses DFS to check if we can reach source_type_id starting from destination_type_id.

        Returns True if cycle found.
        """
        visited: set[UUID] = set()
        stack = [destination_type_id]

        while stack:
            current = stack.pop()
            if current == source_type_id:
                return True  # Cycle found

            if current in visited:
                continue
            visited.add(current)

            # Get all destinations reachable from current
            rows = await conn.fetch(
                """
                SELECT destination_target_type_id
                FROM graduation_rules
                WHERE organization_id = $1
                  AND source_target_type_id = $2
                  AND enabled = TRUE
                  AND ($3::uuid IS NULL OR id != $3)
                """,
                org_id,
                current,
                exclude_rule_id,
            )

            for row in rows:
                stack.append(row["destination_target_type_id"])

        return False  # No cycle

    @staticmethod
    async def list_graduation_events(
        conn: asyncpg.Connection,
        org_id: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List graduation events for an organization with joined names."""
        rows = await conn.fetch(
            """
            SELECT
                ge.id,
                ge.target_id,
                t.email as target_email,
                ge.rule_id,
                gr.name as rule_name,
                ge.source_target_type_id,
                st.name as source_type_name,
                ge.destination_target_type_id,
                dt.name as destination_type_name,
                ge.manual,
                ge.triggered_by_user_id,
                u.email as triggered_by_email,
                ge.created_at
            FROM graduation_events ge
            LEFT JOIN targets t ON t.id = ge.target_id
            LEFT JOIN graduation_rules gr ON gr.id = ge.rule_id
            JOIN target_types st ON st.id = ge.source_target_type_id
            JOIN target_types dt ON dt.id = ge.destination_target_type_id
            LEFT JOIN users u ON u.id = ge.triggered_by_user_id
            WHERE ge.organization_id = $1
            ORDER BY ge.created_at DESC
            LIMIT $2 OFFSET $3
            """,
            org_id,
            limit,
            offset,
        )
        return [dict(r) for r in rows]

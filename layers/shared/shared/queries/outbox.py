"""Outbox-related database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg


class OutboxQueries:
    """Database queries for outbox items."""

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: str,
        target_id: UUID,
        channel: str,
        body: str,
        subject: Optional[str] = None,
        confidence_score: Optional[float] = None,
        priority: int = 5,
        scheduled_for: Optional[str] = None,
        created_by: Optional[UUID] = None,
        status: str = "pending",
    ) -> dict[str, Any]:
        """Create a new outbox item.

        Args:
            status: Initial status. Use 'approved' for auto-approval (sets reviewed_at).
        """
        row = await conn.fetchrow(
            """
            INSERT INTO outbox (
                organization_id, target_id, channel, subject, body,
                confidence_score, priority, scheduled_for, created_by,
                status, reviewed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                CASE WHEN $10 = 'approved' THEN NOW() ELSE NULL END)
            RETURNING *
            """,
            org_id,
            target_id,
            channel,
            subject,
            body,
            confidence_score,
            priority,
            scheduled_for,
            created_by,
            status,
        )
        return dict(row)

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        outbox_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get outbox item by ID."""
        row = await conn.fetchrow(
            "SELECT * FROM outbox WHERE id = $1",
            outbox_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
        channel: Optional[str] = None,
        target_id: Optional[UUID] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List outbox items with optional filters."""
        conditions = ["o.organization_id = $1"]
        params: list[Any] = [org_id]
        param_idx = 2

        if status:
            conditions.append(f"o.status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if channel:
            conditions.append(f"o.channel = ${param_idx}")
            params.append(channel)
            param_idx += 1

        if target_id:
            conditions.append(f"o.target_id = ${param_idx}")
            params.append(target_id)
            param_idx += 1

        where_clause = " AND ".join(conditions)
        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT o.*, t.email, t.first_name, t.last_name, t.company, t.metadata,
                   es.delivered_at, es.opened_at, es.clicked_at,
                   es.bounced_at, es.complained_at
            FROM outbox o
            LEFT JOIN targets t ON o.target_id = t.id
            LEFT JOIN LATERAL (
                SELECT delivered_at, opened_at, clicked_at, bounced_at, complained_at
                FROM email_sends
                WHERE outbox_id = o.id
                ORDER BY created_at DESC
                LIMIT 1
            ) es ON true
            WHERE {where_clause}
            ORDER BY o.priority DESC, o.created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def list_pending(
        conn: asyncpg.Connection,
        org_id: str,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List pending outbox items ordered by priority."""
        rows = await conn.fetch(
            """
            SELECT o.*, t.email, t.first_name, t.last_name, t.company, t.metadata
            FROM outbox o
            LEFT JOIN targets t ON o.target_id = t.id
            WHERE o.organization_id = $1 AND o.status = 'pending'
            ORDER BY o.priority DESC, o.created_at ASC
            LIMIT $2 OFFSET $3
            """,
            org_id,
            limit,
            offset,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def count(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
    ) -> int:
        """Count outbox items in organization."""
        if status:
            row = await conn.fetchrow(
                "SELECT COUNT(*) FROM outbox WHERE organization_id = $1 AND status = $2",
                org_id,
                status,
            )
        else:
            row = await conn.fetchrow(
                "SELECT COUNT(*) FROM outbox WHERE organization_id = $1",
                org_id,
            )
        return row["count"] if row else 0

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update outbox item fields."""
        if not fields:
            return await OutboxQueries.get_by_id(conn, outbox_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            if value is not None:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return await OutboxQueries.get_by_id(conn, outbox_id)

        params.append(outbox_id)

        row = await conn.fetchrow(
            f"""
            UPDATE outbox
            SET {", ".join(set_clauses)}
            WHERE id = ${param_idx}
            RETURNING *
            """,
            *params,
        )
        return dict(row) if row else None

    @staticmethod
    async def approve(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        reviewed_by: Optional[UUID] = None,
    ) -> Optional[dict[str, Any]]:
        """Approve an outbox item for sending."""
        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING *
            """,
            outbox_id,
            reviewed_by,
        )
        return dict(row) if row else None

    @staticmethod
    async def reject(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        rejection_reason: Optional[str] = None,
        reviewed_by: Optional[UUID] = None,
    ) -> Optional[dict[str, Any]]:
        """Reject an outbox item."""
        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'rejected', rejection_reason = $2,
                reviewed_by = $3, reviewed_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING *
            """,
            outbox_id,
            rejection_reason,
            reviewed_by,
        )
        return dict(row) if row else None

    @staticmethod
    async def snooze(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        snooze_until: str,
        reviewed_by: Optional[UUID] = None,
    ) -> Optional[dict[str, Any]]:
        """Snooze an outbox item until a specific time."""
        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'snoozed', snooze_until = $2,
                reviewed_by = $3, reviewed_at = NOW()
            WHERE id = $1 AND status = 'pending'
            RETURNING *
            """,
            outbox_id,
            snooze_until,
            reviewed_by,
        )
        return dict(row) if row else None

    @staticmethod
    async def unsnooze_due(
        conn: asyncpg.Connection,
        org_id: str,
    ) -> int:
        """Unsnooze items whose snooze time has passed."""
        result = await conn.execute(
            """
            UPDATE outbox
            SET status = 'pending', snooze_until = NULL
            WHERE organization_id = $1
              AND status = 'snoozed'
              AND snooze_until <= NOW()
            """,
            org_id,
        )
        return int(result.split()[-1])

    @staticmethod
    async def mark_sent(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        send_result: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        """Mark an outbox item as sent with result details."""
        import json

        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'sent', send_result = $2
            WHERE id = $1 AND status = 'approved'
            RETURNING *
            """,
            outbox_id,
            json.dumps(send_result),
        )
        return dict(row) if row else None

    @staticmethod
    async def mark_failed(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        error: str,
    ) -> Optional[dict[str, Any]]:
        """Mark an outbox item as failed."""
        import json

        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'failed', send_result = $2
            WHERE id = $1 AND status = 'approved'
            RETURNING *
            """,
            outbox_id,
            json.dumps({"error": error}),
        )
        return dict(row) if row else None

    @staticmethod
    async def retry(
        conn: asyncpg.Connection,
        outbox_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Retry a failed outbox item by resetting to approved status."""
        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET status = 'approved', send_result = NULL
            WHERE id = $1 AND status = 'failed'
            RETURNING *
            """,
            outbox_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def add_edit(
        conn: asyncpg.Connection,
        outbox_id: UUID,
        user_id: UUID,
        field: str,
        old_value: str,
        new_value: str,
    ) -> Optional[dict[str, Any]]:
        """Add an edit to the edit history."""
        import json
        from datetime import datetime, timezone

        edit_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "user_id": str(user_id),
            "field": field,
            "old_value": old_value,
            "new_value": new_value,
        }

        row = await conn.fetchrow(
            """
            UPDATE outbox
            SET edit_history = edit_history || $2::jsonb
            WHERE id = $1
            RETURNING *
            """,
            outbox_id,
            json.dumps([edit_entry]),
        )
        return dict(row) if row else None

    @staticmethod
    async def delete(
        conn: asyncpg.Connection,
        outbox_id: UUID,
    ) -> bool:
        """Delete an outbox item."""
        result = await conn.execute(
            "DELETE FROM outbox WHERE id = $1",
            outbox_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_stats(
        conn: asyncpg.Connection,
        org_id: str,
    ) -> dict[str, int]:
        """Get outbox statistics by status."""
        rows = await conn.fetch(
            """
            SELECT status, COUNT(*) as count
            FROM outbox
            WHERE organization_id = $1
            GROUP BY status
            """,
            org_id,
        )
        return {row["status"]: row["count"] for row in rows}

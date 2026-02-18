"""Sequence-related database queries."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

import asyncpg


class SequenceQueries:
    """Database queries for sequences."""

    # =========================================================================
    # SEQUENCES
    # =========================================================================

    @staticmethod
    async def create(
        conn: asyncpg.Connection,
        org_id: str,
        name: str,
        target_type_id: Optional[UUID] = None,
        status: str = "draft",
    ) -> dict[str, Any]:
        """Create a new sequence."""
        row = await conn.fetchrow(
            """
            INSERT INTO sequences (organization_id, name, target_type_id, status)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            org_id,
            name,
            target_type_id,
            status,
        )
        return dict(row)

    @staticmethod
    async def get_by_id(
        conn: asyncpg.Connection,
        sequence_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get sequence by ID with steps."""
        row = await conn.fetchrow(
            """
            SELECT s.*,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', ss.id,
                            'position', ss.position,
                            'default_delay_hours', ss.default_delay_hours,
                            'subject', ss.subject,
                            'builder_content', ss.builder_content,
                            'has_unpublished_changes', ss.has_unpublished_changes,
                            'approval_required', ss.approval_required
                        )
                        ORDER BY ss.position
                    ) FILTER (WHERE ss.id IS NOT NULL),
                    '[]'
                ) as steps
            FROM sequences s
            LEFT JOIN sequence_steps ss ON ss.sequence_id = s.id
            WHERE s.id = $1
            GROUP BY s.id
            """,
            sequence_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list(
        conn: asyncpg.Connection,
        org_id: str,
        status: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List sequences with optional filters and stats."""
        conditions = ["s.organization_id = $1"]
        params: list[Any] = [org_id]
        param_idx = 2

        if status:
            conditions.append(f"s.status = ${param_idx}")
            params.append(status)
            param_idx += 1

        if target_type_id:
            conditions.append(f"s.target_type_id = ${param_idx}")
            params.append(target_type_id)
            param_idx += 1

        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT
                s.*,
                COALESCE(step_stats.step_count, 0) as step_count,
                COALESCE(step_stats.total_duration_days, 0) as total_duration_days,
                COALESCE(enrollment_stats.total_enrollments, 0) as total_enrollments,
                COALESCE(enrollment_stats.active_enrollments, 0) as active_enrollments,
                COALESCE(enrollment_stats.exited_enrollments, 0) as exited_enrollments,
                COALESCE(enrollment_stats.unsubscribed_count, 0) as unsubscribed_count,
                CASE
                    WHEN COALESCE(email_stats.sent_count, 0) > 0
                    THEN ROUND(COALESCE(email_stats.opened_count, 0)::numeric / email_stats.sent_count * 100, 2)
                    ELSE 0
                END as open_rate,
                CASE
                    WHEN COALESCE(email_stats.sent_count, 0) > 0
                    THEN ROUND(COALESCE(email_stats.clicked_count, 0)::numeric / email_stats.sent_count * 100, 2)
                    ELSE 0
                END as click_rate
            FROM sequences s
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) as step_count,
                    COALESCE(SUM(default_delay_hours) / 24, 0) as total_duration_days
                FROM sequence_steps
                WHERE sequence_id = s.id
            ) step_stats ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) as total_enrollments,
                    COUNT(*) FILTER (WHERE status = 'active') as active_enrollments,
                    COUNT(*) FILTER (WHERE status = 'exited') as exited_enrollments,
                    COUNT(*) FILTER (WHERE status = 'exited' AND exit_reason = 'unsubscribed') as unsubscribed_count
                FROM sequence_enrollments
                WHERE sequence_id = s.id
            ) enrollment_stats ON true
            LEFT JOIN LATERAL (
                SELECT
                    COUNT(*) as sent_count,
                    COUNT(*) FILTER (WHERE es.opened_at IS NOT NULL) as opened_count,
                    COUNT(*) FILTER (WHERE es.clicked_at IS NOT NULL) as clicked_count
                FROM sequence_step_executions sse
                LEFT JOIN email_sends es ON es.outbox_id = sse.outbox_id
                WHERE sse.enrollment_id IN (
                    SELECT id FROM sequence_enrollments WHERE sequence_id = s.id
                )
                AND es.id IS NOT NULL
            ) email_stats ON true
            WHERE {" AND ".join(conditions)}
            ORDER BY s.created_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def update(
        conn: asyncpg.Connection,
        sequence_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update sequence fields."""
        if not fields:
            return await SequenceQueries.get_by_id(conn, sequence_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            set_clauses.append(f"{key} = ${param_idx}")
            params.append(value)
            param_idx += 1

        if not set_clauses:
            return await SequenceQueries.get_by_id(conn, sequence_id)

        params.append(sequence_id)

        row = await conn.fetchrow(
            f"""
            UPDATE sequences
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
        sequence_id: UUID,
    ) -> bool:
        """Delete a sequence (cascades to steps, step_contents)."""
        result = await conn.execute(
            "DELETE FROM sequences WHERE id = $1",
            sequence_id,
        )
        return result == "DELETE 1"

    # =========================================================================
    # SEQUENCE STEPS
    # =========================================================================

    @staticmethod
    async def create_step(
        conn: asyncpg.Connection,
        sequence_id: UUID,
        org_id: str,
        position: int,
        default_delay_hours: int = 24,
    ) -> dict[str, Any]:
        """Create a new sequence step."""
        row = await conn.fetchrow(
            """
            INSERT INTO sequence_steps (
                sequence_id, organization_id, position, default_delay_hours
            )
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            sequence_id,
            org_id,
            position,
            default_delay_hours,
        )
        return dict(row)

    @staticmethod
    async def get_step(
        conn: asyncpg.Connection,
        step_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get step by ID."""
        row = await conn.fetchrow(
            "SELECT * FROM sequence_steps WHERE id = $1",
            step_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_step_by_position(
        conn: asyncpg.Connection,
        sequence_id: UUID,
        position: int,
    ) -> Optional[dict[str, Any]]:
        """Get step by sequence and position."""
        row = await conn.fetchrow(
            """
            SELECT * FROM sequence_steps
            WHERE sequence_id = $1 AND position = $2
            """,
            sequence_id,
            position,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_steps(
        conn: asyncpg.Connection,
        sequence_id: UUID,
    ) -> list[dict[str, Any]]:
        """List all steps for a sequence ordered by position."""
        rows = await conn.fetch(
            """
            SELECT * FROM sequence_steps
            WHERE sequence_id = $1
            ORDER BY position
            """,
            sequence_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def update_step(
        conn: asyncpg.Connection,
        step_id: UUID,
        **fields: Any,
    ) -> Optional[dict[str, Any]]:
        """Update step fields."""
        if not fields:
            return await SequenceQueries.get_step(conn, step_id)

        set_clauses = []
        params: list[Any] = []
        param_idx = 1

        for key, value in fields.items():
            if value is not None:
                set_clauses.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

        if not set_clauses:
            return await SequenceQueries.get_step(conn, step_id)

        params.append(step_id)

        row = await conn.fetchrow(
            f"""
            UPDATE sequence_steps
            SET {", ".join(set_clauses)}
            WHERE id = ${param_idx}
            RETURNING *
            """,
            *params,
        )
        return dict(row) if row else None

    @staticmethod
    async def delete_step(
        conn: asyncpg.Connection,
        step_id: UUID,
    ) -> bool:
        """Delete a step (cascades to step_contents)."""
        result = await conn.execute(
            "DELETE FROM sequence_steps WHERE id = $1",
            step_id,
        )
        return result == "DELETE 1"

    @staticmethod
    async def get_step_content(
        conn: asyncpg.Connection,
        step_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get step content in format expected by scheduler.

        Returns content dict with content_id, content_subject, content_body.
        The body is currently empty as builder_content requires client-side rendering.
        """
        row = await conn.fetchrow(
            """
            SELECT id, subject, builder_content, approval_required
            FROM sequence_steps WHERE id = $1
            """,
            step_id,
        )
        if not row:
            return None

        # Return content in the format expected by the scheduler handler
        # content_id is None since content is stored directly on the step,
        # not in the separate content table
        return {
            "content_id": None,
            "content_subject": row["subject"] or "",
            "content_body": "",  # TODO: Server-side MJML compilation from builder_content
            "builder_content": row["builder_content"],
            "approval_required": row["approval_required"],
        }

    # =========================================================================
    # ENROLLMENTS
    # =========================================================================

    @staticmethod
    async def get_first_step_delay(
        conn: asyncpg.Connection,
        sequence_id: UUID,
    ) -> int:
        """Get the delay hours of the first step in a sequence."""
        row = await conn.fetchrow(
            """
            SELECT default_delay_hours
            FROM sequence_steps
            WHERE sequence_id = $1 AND position = 1
            """,
            sequence_id,
        )
        return row["default_delay_hours"] if row else 0

    @staticmethod
    async def enroll(
        conn: asyncpg.Connection,
        org_id: str,
        target_id: UUID,
        sequence_id: UUID,
        first_step_delay_hours: Optional[int] = None,
    ) -> dict[str, Any]:
        """Enroll a target in a sequence.

        Args:
            conn: Database connection
            org_id: Organization ID
            target_id: Target ID to enroll
            sequence_id: Sequence ID to enroll in
            first_step_delay_hours: Delay before first step. If None, uses
                the first step's configured default_delay_hours.
        """
        # If no explicit delay provided, use the first step's configured delay
        if first_step_delay_hours is None:
            first_step_delay_hours = await SequenceQueries.get_first_step_delay(
                conn, sequence_id
            )

        next_eval = datetime.now(timezone.utc) + timedelta(hours=first_step_delay_hours)
        row = await conn.fetchrow(
            """
            INSERT INTO sequence_enrollments (
                organization_id, target_id, sequence_id,
                current_step_position, status, next_evaluation_at
            )
            VALUES ($1, $2, $3, 1, 'active', $4)
            RETURNING *
            """,
            org_id,
            target_id,
            sequence_id,
            next_eval,
        )
        return dict(row)

    @staticmethod
    async def get_enrollment(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get enrollment by ID."""
        row = await conn.fetchrow(
            """
            SELECT e.*, s.name as sequence_name, t.email as target_email
            FROM sequence_enrollments e
            JOIN sequences s ON s.id = e.sequence_id
            JOIN targets t ON t.id = e.target_id
            WHERE e.id = $1
            """,
            enrollment_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def get_active_enrollment(
        conn: asyncpg.Connection,
        target_id: UUID,
        sequence_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get active/paused enrollment for target in sequence."""
        row = await conn.fetchrow(
            """
            SELECT * FROM sequence_enrollments
            WHERE target_id = $1
              AND sequence_id = $2
              AND status IN ('active', 'paused')
            """,
            target_id,
            sequence_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_enrollments(
        conn: asyncpg.Connection,
        org_id: str,
        sequence_id: Optional[UUID] = None,
        target_id: Optional[UUID] = None,
        status: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """List enrollments with optional filters."""
        conditions = ["e.organization_id = $1"]
        params: list[Any] = [org_id]
        param_idx = 2

        if sequence_id:
            conditions.append(f"e.sequence_id = ${param_idx}")
            params.append(sequence_id)
            param_idx += 1

        if target_id:
            conditions.append(f"e.target_id = ${param_idx}")
            params.append(target_id)
            param_idx += 1

        if status:
            conditions.append(f"e.status = ${param_idx}")
            params.append(status)
            param_idx += 1

        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT e.*, s.name as sequence_name, t.email as target_email
            FROM sequence_enrollments e
            JOIN sequences s ON s.id = e.sequence_id
            JOIN targets t ON t.id = e.target_id
            WHERE {" AND ".join(conditions)}
            ORDER BY e.enrolled_at DESC
            LIMIT ${param_idx} OFFSET ${param_idx + 1}
            """,
            *params,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def pause_enrollment(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Pause an enrollment."""
        row = await conn.fetchrow(
            """
            UPDATE sequence_enrollments
            SET status = 'paused', paused_at = NOW()
            WHERE id = $1 AND status = 'active'
            RETURNING *
            """,
            enrollment_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def resume_enrollment(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Resume a paused enrollment, adjusting next_evaluation_at."""
        row = await conn.fetchrow(
            """
            UPDATE sequence_enrollments
            SET status = 'active',
                next_evaluation_at = next_evaluation_at + (NOW() - paused_at),
                paused_at = NULL
            WHERE id = $1 AND status = 'paused'
            RETURNING *
            """,
            enrollment_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def pause_all_enrollments(
        conn: asyncpg.Connection,
        sequence_id: UUID,
    ) -> int:
        """Pause all active enrollments for a sequence."""
        result = await conn.execute(
            """
            UPDATE sequence_enrollments
            SET status = 'paused', paused_at = NOW()
            WHERE sequence_id = $1 AND status = 'active'
            """,
            sequence_id,
        )
        # Extract count from "UPDATE N"
        return int(result.split()[-1]) if result else 0

    @staticmethod
    async def resume_all_enrollments(
        conn: asyncpg.Connection,
        sequence_id: UUID,
    ) -> int:
        """Resume all paused enrollments for a sequence."""
        result = await conn.execute(
            """
            UPDATE sequence_enrollments
            SET status = 'active',
                next_evaluation_at = next_evaluation_at + (NOW() - paused_at),
                paused_at = NULL
            WHERE sequence_id = $1 AND status = 'paused'
            """,
            sequence_id,
        )
        # Extract count from "UPDATE N"
        return int(result.split()[-1]) if result else 0

    @staticmethod
    async def complete_enrollment(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
        status: str = "completed",
        exit_reason: Optional[str] = None,
    ) -> Optional[dict[str, Any]]:
        """Complete or exit an enrollment."""
        row = await conn.fetchrow(
            """
            UPDATE sequence_enrollments
            SET status = $2, exit_reason = $3
            WHERE id = $1 AND status IN ('active', 'paused')
            RETURNING *
            """,
            enrollment_id,
            status,
            exit_reason,
        )
        return dict(row) if row else None

    @staticmethod
    async def advance_enrollment(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
        next_step_delay_hours: int,
    ) -> Optional[dict[str, Any]]:
        """Advance enrollment to next step."""
        next_eval = datetime.now(timezone.utc) + timedelta(hours=next_step_delay_hours)
        row = await conn.fetchrow(
            """
            UPDATE sequence_enrollments
            SET current_step_position = current_step_position + 1,
                last_step_completed_at = NOW(),
                next_evaluation_at = $2
            WHERE id = $1 AND status = 'active'
            RETURNING *
            """,
            enrollment_id,
            next_eval,
        )
        return dict(row) if row else None

    # =========================================================================
    # SCHEDULER QUERIES
    # =========================================================================

    @staticmethod
    async def get_due_enrollments(
        conn: asyncpg.Connection,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """Get enrollments due for evaluation, marking them as in-progress.

        Uses a CTE to atomically select and update next_evaluation_at to prevent
        duplicate processing if the scheduler runs again while processing is ongoing.
        The next_evaluation_at is set 10 minutes in the future as a processing window.
        """
        rows = await conn.fetch(
            """
            WITH selected AS (
                SELECT e.id
                FROM sequence_enrollments e
                JOIN sequences s ON s.id = e.sequence_id
                JOIN organizations o ON o.id = e.organization_id
                WHERE e.status = 'active'
                  AND e.next_evaluation_at <= NOW()
                  AND s.status = 'active'
                ORDER BY e.next_evaluation_at
                FOR UPDATE OF e SKIP LOCKED
                LIMIT $1
            ),
            updated AS (
                UPDATE sequence_enrollments
                SET next_evaluation_at = NOW() + INTERVAL '10 minutes'
                WHERE id IN (SELECT id FROM selected)
                RETURNING *
            )
            SELECT u.*, s.name as sequence_name, t.email as target_email,
                   t.first_name as target_first_name, t.last_name as target_last_name,
                   t.company as target_company, t.custom_fields as target_custom_fields,
                   t.phone_normalized as target_phone, t.metadata as target_metadata,
                   t.status as target_status,
                   o.agentplane_tenant_id, o.agentplane_agent_id
            FROM updated u
            JOIN sequences s ON s.id = u.sequence_id
            JOIN targets t ON t.id = u.target_id
            JOIN organizations o ON o.id = u.organization_id
            """,
            limit,
        )
        return [dict(row) for row in rows]

    # =========================================================================
    # STEP EXECUTIONS
    # =========================================================================

    @staticmethod
    async def record_execution(
        conn: asyncpg.Connection,
        org_id: str,
        enrollment_id: UUID,
        step_position: int,
        content_id: Optional[UUID] = None,
        email_send_id: Optional[UUID] = None,
        outbox_id: Optional[UUID] = None,
        status: str = "executed",
    ) -> dict[str, Any]:
        """Record a step execution."""
        row = await conn.fetchrow(
            """
            INSERT INTO sequence_step_executions (
                organization_id, enrollment_id, step_position,
                content_id, email_send_id, outbox_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            org_id,
            enrollment_id,
            step_position,
            content_id,
            email_send_id,
            outbox_id,
            status,
        )
        return dict(row)

    @staticmethod
    async def list_executions(
        conn: asyncpg.Connection,
        enrollment_id: UUID,
    ) -> list[dict[str, Any]]:
        """List all executions for an enrollment."""
        rows = await conn.fetch(
            """
            SELECT sse.*, c.name as content_name
            FROM sequence_step_executions sse
            LEFT JOIN content c ON c.id = sse.content_id
            WHERE sse.enrollment_id = $1
            ORDER BY sse.step_position
            """,
            enrollment_id,
        )
        return [dict(row) for row in rows]

    # =========================================================================
    # DEFAULT SEQUENCE METHODS
    # =========================================================================

    @staticmethod
    async def get_default_for_target_type(
        conn: asyncpg.Connection,
        org_id: str,
        target_type_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get the default sequence for a target type (only if active)."""
        row = await conn.fetchrow(
            """
            SELECT * FROM sequences
            WHERE organization_id = $1
              AND target_type_id = $2
              AND is_default = TRUE
              AND status = 'active'
            """,
            org_id,
            target_type_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def unset_default_for_target_type(
        conn: asyncpg.Connection,
        org_id: str,
        target_type_id: UUID,
    ) -> None:
        """Unset default for all sequences of a target type."""
        await conn.execute(
            """
            UPDATE sequences
            SET is_default = FALSE
            WHERE organization_id = $1
              AND target_type_id = $2
              AND is_default = TRUE
            """,
            org_id,
            target_type_id,
        )

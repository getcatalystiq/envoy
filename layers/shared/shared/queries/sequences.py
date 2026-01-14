"""Sequence-related database queries."""

from __future__ import annotations

from datetime import datetime, timedelta
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
        target_type_id: UUID,
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
        """Get sequence by ID with steps and step contents."""
        row = await conn.fetchrow(
            """
            SELECT s.*,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', ss.id,
                            'position', ss.position,
                            'default_delay_hours', ss.default_delay_hours,
                            'contents', (
                                SELECT COALESCE(
                                    json_agg(
                                        json_build_object(
                                            'id', ssc.id,
                                            'content_id', ssc.content_id,
                                            'priority', ssc.priority
                                        )
                                        ORDER BY ssc.priority
                                    ),
                                    '[]'
                                )
                                FROM sequence_step_contents ssc
                                WHERE ssc.sequence_step_id = ss.id
                            )
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
        """List sequences with optional filters."""
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

        params.extend([limit, offset])

        rows = await conn.fetch(
            f"""
            SELECT * FROM sequences
            WHERE {" AND ".join(conditions)}
            ORDER BY created_at DESC
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
            if value is not None:
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

    # =========================================================================
    # SEQUENCE STEP CONTENTS
    # =========================================================================

    @staticmethod
    async def add_step_content(
        conn: asyncpg.Connection,
        step_id: UUID,
        org_id: str,
        content_id: UUID,
        priority: int = 1,
    ) -> dict[str, Any]:
        """Add content to a step."""
        row = await conn.fetchrow(
            """
            INSERT INTO sequence_step_contents (
                sequence_step_id, organization_id, content_id, priority
            )
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (sequence_step_id, content_id)
            DO UPDATE SET priority = $4
            RETURNING *
            """,
            step_id,
            org_id,
            content_id,
            priority,
        )
        return dict(row)

    @staticmethod
    async def get_step_content(
        conn: asyncpg.Connection,
        step_id: UUID,
    ) -> Optional[dict[str, Any]]:
        """Get highest priority content for a step."""
        row = await conn.fetchrow(
            """
            SELECT ssc.*, c.name as content_name, c.body as content_body,
                   c.subject as content_subject
            FROM sequence_step_contents ssc
            JOIN content c ON c.id = ssc.content_id
            WHERE ssc.sequence_step_id = $1
            ORDER BY ssc.priority
            LIMIT 1
            """,
            step_id,
        )
        return dict(row) if row else None

    @staticmethod
    async def list_step_contents(
        conn: asyncpg.Connection,
        step_id: UUID,
    ) -> list[dict[str, Any]]:
        """List all content options for a step ordered by priority."""
        rows = await conn.fetch(
            """
            SELECT ssc.*, c.name as content_name
            FROM sequence_step_contents ssc
            JOIN content c ON c.id = ssc.content_id
            WHERE ssc.sequence_step_id = $1
            ORDER BY ssc.priority
            """,
            step_id,
        )
        return [dict(row) for row in rows]

    @staticmethod
    async def remove_step_content(
        conn: asyncpg.Connection,
        step_id: UUID,
        content_id: UUID,
    ) -> bool:
        """Remove content from a step."""
        result = await conn.execute(
            """
            DELETE FROM sequence_step_contents
            WHERE sequence_step_id = $1 AND content_id = $2
            """,
            step_id,
            content_id,
        )
        return result == "DELETE 1"

    # =========================================================================
    # ENROLLMENTS
    # =========================================================================

    @staticmethod
    async def enroll(
        conn: asyncpg.Connection,
        org_id: str,
        target_id: UUID,
        sequence_id: UUID,
        first_step_delay_hours: int = 0,
    ) -> dict[str, Any]:
        """Enroll a target in a sequence."""
        next_eval = datetime.utcnow() + timedelta(hours=first_step_delay_hours)
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
        next_eval = datetime.utcnow() + timedelta(hours=next_step_delay_hours)
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
        """Get enrollments due for evaluation with row locking."""
        rows = await conn.fetch(
            """
            SELECT e.*, s.name as sequence_name, t.email as target_email,
                   t.data as target_data, t.converted, t.unsubscribed,
                   t.status as target_status
            FROM sequence_enrollments e
            JOIN sequences s ON s.id = e.sequence_id
            JOIN targets t ON t.id = e.target_id
            WHERE e.status = 'active'
              AND e.next_evaluation_at <= NOW()
              AND s.status = 'active'
            ORDER BY e.next_evaluation_at
            FOR UPDATE OF e SKIP LOCKED
            LIMIT $1
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
        status: str = "executed",
    ) -> dict[str, Any]:
        """Record a step execution."""
        row = await conn.fetchrow(
            """
            INSERT INTO sequence_step_executions (
                organization_id, enrollment_id, step_position,
                content_id, email_send_id, status
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            org_id,
            enrollment_id,
            step_position,
            content_id,
            email_send_id,
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

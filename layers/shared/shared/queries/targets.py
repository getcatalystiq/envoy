"""Target-related database queries."""

from __future__ import annotations

from typing import Any, Optional
from uuid import UUID

import asyncpg

from ..phone_utils import normalize_phone


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

    @staticmethod
    async def get_by_phone(
        conn: asyncpg.Connection,
        org_id: str,
        phone_normalized: str,
    ) -> Optional[dict[str, Any]]:
        """Get target by normalized phone number within organization."""
        row = await conn.fetchrow(
            """
            SELECT * FROM targets
            WHERE organization_id = $1 AND phone_normalized = $2
            """,
            org_id,
            phone_normalized,
        )
        return dict(row) if row else None

    @staticmethod
    async def find_by_email_or_phone(
        conn: asyncpg.Connection,
        org_id: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
    ) -> tuple[Optional[dict[str, Any]], Optional[str]]:
        """
        Find existing target by email or phone.

        Priority: email > phone (email is more reliable for deduplication)

        Args:
            conn: Database connection
            org_id: Organization ID
            email: Email address to match
            phone: Phone number (will be normalized)

        Returns:
            Tuple of (target_dict, matched_field) or (None, None)
        """
        # Try email first (most reliable)
        if email:
            target = await TargetQueries.get_by_email(conn, org_id, email)
            if target:
                return target, "email"

        # Try phone (normalized)
        if phone:
            phone_normalized = normalize_phone(phone)
            if phone_normalized:
                target = await TargetQueries.get_by_phone(conn, org_id, phone_normalized)
                if target:
                    return target, "phone"

        return None, None

    @staticmethod
    async def upsert(
        conn: asyncpg.Connection,
        org_id: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        first_name: Optional[str] = None,
        last_name: Optional[str] = None,
        company: Optional[str] = None,
        target_type_id: Optional[UUID] = None,
        segment_id: Optional[UUID] = None,
        lifecycle_stage: Optional[int] = None,
        custom_fields: Optional[dict[str, Any]] = None,
    ) -> tuple[dict[str, Any], str, Optional[str]]:
        """
        Upsert a target - update if exists, create if not.

        Matching logic:
        1. If email provided → search by email
        2. If phone provided → normalize and search by phone
        3. No match found → create new target

        Args:
            conn: Database connection
            org_id: Organization ID
            email: Email address
            phone: Phone number (will be normalized)
            first_name: First name
            last_name: Last name
            company: Company name
            target_type_id: Target type UUID
            segment_id: Segment UUID
            lifecycle_stage: Lifecycle stage (0-6)
            custom_fields: Additional custom fields (JSONB)

        Returns:
            Tuple of (target_dict, action, matched_on)
            - action: "created" or "updated"
            - matched_on: "email", "phone", or None
        """
        # Normalize phone
        phone_normalized = normalize_phone(phone)

        # Find existing target
        existing, matched_on = await TargetQueries.find_by_email_or_phone(
            conn, org_id, email, phone
        )

        if existing:
            # Update existing target
            update_fields = {}

            # Update email if provided and target was matched by phone
            if email and matched_on == "phone" and not existing.get("email"):
                update_fields["email"] = email

            # Update phone if provided and different
            if phone and phone != existing.get("phone"):
                update_fields["phone"] = phone
                update_fields["phone_normalized"] = phone_normalized

            # Update other fields if provided
            if first_name:
                update_fields["first_name"] = first_name
            if last_name:
                update_fields["last_name"] = last_name
            if company:
                update_fields["company"] = company
            if target_type_id:
                update_fields["target_type_id"] = target_type_id
            if segment_id:
                update_fields["segment_id"] = segment_id
            if lifecycle_stage is not None:
                update_fields["lifecycle_stage"] = lifecycle_stage
            if custom_fields:
                # Merge custom fields
                merged_custom = {**(existing.get("custom_fields") or {}), **custom_fields}
                update_fields["custom_fields"] = merged_custom

            if update_fields:
                updated = await TargetQueries.update(conn, existing["id"], **update_fields)
                return updated or existing, "updated", matched_on
            return existing, "updated", matched_on

        # Create new target
        if not email:
            raise ValueError("Email is required when creating a new target")

        row = await conn.fetchrow(
            """
            INSERT INTO targets (
                organization_id, email, phone, phone_normalized,
                first_name, last_name, company,
                target_type_id, segment_id, lifecycle_stage, custom_fields
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            org_id,
            email,
            phone,
            phone_normalized,
            first_name,
            last_name,
            company,
            target_type_id,
            segment_id,
            lifecycle_stage or 0,
            custom_fields or {},
        )
        return dict(row), "created", None

    @staticmethod
    async def bulk_upsert(
        conn: asyncpg.Connection,
        org_id: str,
        targets: list[dict[str, Any]],
    ) -> tuple[int, int, list[dict[str, Any]]]:
        """
        Bulk upsert multiple targets.

        Args:
            conn: Database connection
            org_id: Organization ID
            targets: List of target dicts with email, phone, etc.

        Returns:
            Tuple of (created_count, updated_count, errors)
        """
        created = 0
        updated = 0
        errors = []

        for i, target_data in enumerate(targets):
            try:
                _, action, _ = await TargetQueries.upsert(
                    conn,
                    org_id,
                    email=target_data.get("email"),
                    phone=target_data.get("phone"),
                    first_name=target_data.get("first_name"),
                    last_name=target_data.get("last_name"),
                    company=target_data.get("company"),
                    target_type_id=target_data.get("target_type_id"),
                    segment_id=target_data.get("segment_id"),
                    lifecycle_stage=target_data.get("lifecycle_stage"),
                    custom_fields=target_data.get("custom_fields"),
                )
                if action == "created":
                    created += 1
                else:
                    updated += 1
            except Exception as e:
                errors.append({"index": i, "error": str(e)})

        return created, updated, errors

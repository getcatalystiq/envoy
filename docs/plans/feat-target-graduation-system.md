# feat: Target Graduation System

## Review Summary

**Reviewed on:** 2026-01-21
**Reviewers:** DHH Rails Reviewer, Kieran Rails Reviewer, Code Simplicity Reviewer

### Changes from Review
1. Dramatically simplified - removed rule engine abstraction, use direct evaluation
2. Removed YAGNI features: idempotency keys, version columns, priority, denormalized names
3. Removed agent-native endpoints for Phase 1 (bulk, preview, test)
4. Moved cycle detection from DB trigger to app layer
5. Fixed error handling - raise exceptions instead of silent `None` returns
6. Reduced from 10 endpoints to 6

---

## Overview

Enable targets to graduate between target types (e.g., prospect → lead → opportunity → customer) based on configurable rules or manual action. Graduation triggers sequence exits from the source type and auto-enrollment in default sequences for the destination type.

## Problem Statement

Currently, targets remain static within their assigned target type. There's no automated mechanism to progress targets through the sales/marketing funnel based on engagement or metadata changes. Organizations need:

1. **Automated progression** - Move targets forward when they meet criteria
2. **Sequence coordination** - Exit current sequences and start new ones appropriate to the new stage
3. **Audit trail** - Track why and when targets graduated

## Proposed Solution

### Core Components

1. **Graduation Rules** - Configurable conditions per organization that trigger automatic graduation
2. **Graduation function** - Executes the graduation (exit sequences → change type → enroll in new sequences)
3. **Manual Graduation** - API endpoint for direct user-triggered graduations

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Multiple rule matches | First match wins (creation order) | Simple, predictable |
| Circular prevention | Block at rule creation (app layer) | Simple DFS check |
| Cascade graduation | No cascading | Single graduation per change event |
| Null field handling | Null != any value, comparisons return false | Safe default |
| Rule changes | Apply to future changes only | Prevent mass unintended graduations |
| Evaluation timing | Synchronous after target update | Immediate feedback |

---

## Technical Approach

### Database Schema

```sql
-- Graduation rules table (simplified)
CREATE TABLE graduation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    destination_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    conditions JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT graduation_rules_different_types
        CHECK (source_target_type_id != destination_target_type_id),
    CONSTRAINT graduation_rules_unique_name
        UNIQUE (organization_id, name)
);

-- Graduation events audit table (simplified)
CREATE TABLE graduation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_id UUID REFERENCES targets(id) ON DELETE SET NULL,
    rule_id UUID REFERENCES graduation_rules(id) ON DELETE SET NULL,
    source_target_type_id UUID NOT NULL,
    destination_target_type_id UUID NOT NULL,
    manual BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_graduation_rules_lookup
    ON graduation_rules(organization_id, source_target_type_id, enabled)
    WHERE enabled = TRUE;

CREATE INDEX idx_graduation_events_target
    ON graduation_events(target_id)
    WHERE target_id IS NOT NULL;

CREATE INDEX idx_graduation_events_org_time
    ON graduation_events(organization_id, created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER set_graduation_rules_updated_at
    BEFORE UPDATE ON graduation_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**Removed from original:**
- `priority` column (first match wins by creation order)
- `idempotency_key` (no retry pattern needed)
- `source_target_type_name`, `destination_target_type_name` (join when needed)
- `version` column on targets (premature optimization)
- Cycle detection trigger (moved to app layer)

### Rule Condition Format

Rules support field conditions with implicit AND logic:

```json
[
  {"field": "metadata.score", "operator": "gt", "value": 50},
  {"field": "custom_fields.replied", "operator": "eq", "value": true}
]
```

**Supported Operators:**
| Operator | Meaning | Example |
|----------|---------|---------|
| `eq` | Equal | `{"field": "status", "operator": "eq", "value": "qualified"}` |
| `ne` | Not equal | `{"field": "status", "operator": "ne", "value": "unsubscribed"}` |
| `gt` | Greater than | `{"field": "metadata.score", "operator": "gt", "value": 50}` |
| `gte` | Greater than or equal | `{"field": "metadata.score", "operator": "gte", "value": 50}` |
| `lt` | Less than | `{"field": "metadata.score", "operator": "lt", "value": 10}` |
| `lte` | Less than or equal | `{"field": "metadata.score", "operator": "lte", "value": 10}` |
| `contains` | String/array contains | `{"field": "tags", "operator": "contains", "value": "vip"}` |
| `exists` | Field is not null | `{"field": "metadata.replied_at", "operator": "exists"}` |

**Allowed Fields (Security Allowlist):**
```python
ALLOWED_FIELDS = frozenset({
    # Direct columns
    'status', 'lifecycle_stage', 'email', 'first_name', 'last_name',
    'company', 'phone', 'title', 'industry',
    # Nested fields (dot notation)
    'custom_fields.*',  # Any key under custom_fields
    'metadata.*',       # Any key under metadata
})

MAX_FIELD_DEPTH = 3  # e.g., metadata.engagement.score
```

---

## Implementation

### Phase 1: Foundation

**Files to create/modify:**

| File | Purpose |
|------|---------|
| `migrations/027_graduation_rules.sql` | Database schema |
| `layers/shared/shared/queries/graduation.py` | Database queries |
| `functions/api/app/schemas.py` | Pydantic schemas |

**Migration: `migrations/027_graduation_rules.sql`**

```sql
BEGIN;

-- Graduation rules table
CREATE TABLE graduation_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    destination_target_type_id UUID NOT NULL REFERENCES target_types(id) ON DELETE RESTRICT,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    conditions JSONB NOT NULL DEFAULT '[]',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT graduation_rules_different_types
        CHECK (source_target_type_id != destination_target_type_id),
    CONSTRAINT graduation_rules_unique_name
        UNIQUE (organization_id, name)
);

-- Graduation events audit table
CREATE TABLE graduation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    target_id UUID REFERENCES targets(id) ON DELETE SET NULL,
    rule_id UUID REFERENCES graduation_rules(id) ON DELETE SET NULL,
    source_target_type_id UUID NOT NULL,
    destination_target_type_id UUID NOT NULL,
    manual BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_graduation_rules_lookup
    ON graduation_rules(organization_id, source_target_type_id, enabled)
    WHERE enabled = TRUE;

CREATE INDEX idx_graduation_events_target
    ON graduation_events(target_id)
    WHERE target_id IS NOT NULL;

CREATE INDEX idx_graduation_events_org_time
    ON graduation_events(organization_id, created_at DESC);

-- Trigger for updated_at
CREATE TRIGGER set_graduation_rules_updated_at
    BEFORE UPDATE ON graduation_rules
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
```

**Queries: `layers/shared/shared/queries/graduation.py`**

```python
"""Database queries for graduation rules and events."""

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
        params = [org_id]

        if source_target_type_id:
            query += f" AND gr.source_target_type_id = ${len(params) + 1}"
            params.append(source_target_type_id)

        if enabled is not None:
            query += f" AND gr.enabled = ${len(params) + 1}"
            params.append(enabled)

        query += " ORDER BY gr.created_at"

        rows = await conn.fetch(query, *params)
        return [dict(r) for r in rows]

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
            rule_id, org_id
        )
        return dict(row) if row else None

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
            org_id, source_target_type_id, destination_target_type_id,
            name, description, conditions, enabled
        )
        return dict(row)

    @staticmethod
    async def update_rule(
        conn: asyncpg.Connection,
        org_id: str,
        rule_id: UUID,
        **updates,
    ) -> Optional[dict[str, Any]]:
        """Update a graduation rule."""
        if not updates:
            return await GraduationQueries.get_rule(conn, org_id, rule_id)

        set_clauses = []
        params = [rule_id, org_id]

        for key, value in updates.items():
            if key == "conditions":
                set_clauses.append(f"{key} = ${len(params) + 1}::jsonb")
            else:
                set_clauses.append(f"{key} = ${len(params) + 1}")
            params.append(value)

        query = f"""
            UPDATE graduation_rules
            SET {", ".join(set_clauses)}
            WHERE id = $1 AND organization_id = $2
            RETURNING *
        """

        row = await conn.fetch(query, *params)
        return dict(row[0]) if row else None

    @staticmethod
    async def delete_rule(
        conn: asyncpg.Connection,
        org_id: str,
        rule_id: UUID,
    ) -> bool:
        """Delete a graduation rule."""
        result = await conn.execute(
            "DELETE FROM graduation_rules WHERE id = $1 AND organization_id = $2",
            rule_id, org_id
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
            org_id, target_type_id
        )
        return [dict(r) for r in rows]

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
            org_id, target_id, rule_id, source_target_type_id,
            destination_target_type_id, manual, triggered_by_user_id
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
        """Check if adding this rule would create a cycle. Returns True if cycle found."""
        # Simple DFS: can we reach source_type_id starting from destination_type_id?
        visited = set()
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
                org_id, current, exclude_rule_id
            )

            for row in rows:
                stack.append(row["destination_target_type_id"])

        return False  # No cycle
```

### Phase 2: Graduation Logic

**Files to create/modify:**

| File | Purpose |
|------|---------|
| `layers/shared/shared/graduation.py` | Graduation functions (not a "service" class) |

**Graduation functions: `layers/shared/shared/graduation.py`**

```python
"""Functions for evaluating and executing target graduations."""

from typing import Any, Optional
from uuid import UUID
import asyncpg
import logging

from .queries.graduation import GraduationQueries
from .queries.targets import TargetQueries

logger = logging.getLogger(__name__)

# Security: Allowlist of fields that can be used in rule conditions
ALLOWED_ROOT_FIELDS = frozenset({
    'status', 'lifecycle_stage', 'email', 'first_name', 'last_name',
    'company', 'phone', 'title', 'industry', 'custom_fields', 'metadata',
})
MAX_FIELD_DEPTH = 3


class GraduationError(Exception):
    """Base exception for graduation errors."""
    pass


class TargetNotFoundError(GraduationError):
    """Target does not exist or is not accessible."""
    pass


class UnauthorizedError(GraduationError):
    """Target does not belong to the organization."""
    pass


class InvalidRuleError(GraduationError):
    """Rule configuration is invalid."""
    pass


def _get_field_value(target: dict[str, Any], field: str) -> Any:
    """Extract a field value from target using dot notation.

    Examples:
        _get_field_value(target, "status") -> target["status"]
        _get_field_value(target, "metadata.score") -> target["metadata"]["score"]
    """
    parts = field.split(".")

    # Security validation
    if len(parts) > MAX_FIELD_DEPTH:
        raise InvalidRuleError(f"Field path too deep: {field}")

    if parts[0] not in ALLOWED_ROOT_FIELDS:
        raise InvalidRuleError(f"Field not allowed: {parts[0]}")

    for part in parts:
        if part.startswith('_'):
            raise InvalidRuleError(f"Private field access forbidden: {part}")

    # Traverse the path
    current = target
    for part in parts:
        if current is None or not isinstance(current, dict):
            return None
        current = current.get(part)

    return current


def _evaluate_condition(condition: dict[str, Any], target: dict[str, Any]) -> bool:
    """Evaluate a single condition against a target."""
    field = condition.get("field", "")
    operator = condition.get("operator", "eq")
    expected = condition.get("value")

    actual = _get_field_value(target, field)

    # Handle None consistently
    if actual is None:
        return operator == "exists" and False or operator != "exists"

    if operator == "eq":
        return actual == expected
    elif operator == "ne":
        return actual != expected
    elif operator == "gt":
        return isinstance(actual, (int, float)) and isinstance(expected, (int, float)) and actual > expected
    elif operator == "gte":
        return isinstance(actual, (int, float)) and isinstance(expected, (int, float)) and actual >= expected
    elif operator == "lt":
        return isinstance(actual, (int, float)) and isinstance(expected, (int, float)) and actual < expected
    elif operator == "lte":
        return isinstance(actual, (int, float)) and isinstance(expected, (int, float)) and actual <= expected
    elif operator == "contains":
        if isinstance(actual, str):
            return expected in actual
        elif isinstance(actual, list):
            return expected in actual
        return False
    elif operator == "exists":
        return actual is not None
    else:
        raise InvalidRuleError(f"Unknown operator: {operator}")


def evaluate_conditions(conditions: list[dict[str, Any]], target: dict[str, Any]) -> bool:
    """Evaluate all conditions against a target (implicit AND)."""
    if not conditions:
        return False
    return all(_evaluate_condition(c, target) for c in conditions)


async def find_matching_rule(
    conn: asyncpg.Connection,
    org_id: str,
    target: dict[str, Any],
) -> Optional[dict[str, Any]]:
    """Find the first matching graduation rule for a target."""
    target_type_id = target.get("target_type_id")
    if not target_type_id:
        return None

    rules = await GraduationQueries.get_rules_for_target_type(conn, org_id, target_type_id)

    # Build evaluation context
    eval_target = {
        **target,
        "custom_fields": target.get("custom_fields") or {},
        "metadata": target.get("metadata") or {},
    }

    for rule in rules:
        conditions = rule.get("conditions", [])
        if conditions and evaluate_conditions(conditions, eval_target):
            return rule

    return None


async def graduate(
    conn: asyncpg.Connection,
    org_id: str,
    target_id: UUID,
    destination_type_id: UUID,
    user_id: Optional[UUID] = None,
    rule_id: Optional[UUID] = None,
) -> dict[str, Any]:
    """Graduate a target to a new type.

    This is the core graduation function. It:
    1. Exits all active sequence enrollments
    2. Updates the target's type
    3. Auto-enrolls in default sequences for the new type
    4. Records the graduation event

    Returns the graduation event record.
    """
    async with conn.transaction():
        # Get and lock the target
        target = await conn.fetchrow(
            "SELECT * FROM targets WHERE id = $1 FOR UPDATE",
            target_id
        )

        if not target:
            raise TargetNotFoundError(f"Target not found: {target_id}")

        if str(target["organization_id"]) != org_id:
            raise UnauthorizedError(f"Target {target_id} does not belong to organization")

        source_type_id = target["target_type_id"]

        if source_type_id == destination_type_id:
            raise GraduationError("Target is already in the destination type")

        # Verify destination type exists and belongs to org
        dest_type = await conn.fetchrow(
            "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
            destination_type_id, org_id
        )
        if not dest_type:
            raise GraduationError(f"Invalid destination type: {destination_type_id}")

        # 1. Exit all active sequence enrollments
        exit_result = await conn.execute(
            """
            UPDATE sequence_enrollments
            SET status = 'exited', exit_reason = 'graduated', updated_at = NOW()
            WHERE organization_id = $1 AND target_id = $2
              AND status IN ('active', 'paused')
            """,
            org_id, target_id
        )
        exited_count = int(exit_result.split()[-1]) if exit_result else 0
        logger.info(f"Exited {exited_count} enrollments for target {target_id}")

        # 2. Update target type
        await conn.execute(
            "UPDATE targets SET target_type_id = $1, updated_at = NOW() WHERE id = $2",
            destination_type_id, target_id
        )

        # 3. Auto-enroll in default sequences for new type
        from .queries.targets import auto_enroll_in_default_sequence
        await auto_enroll_in_default_sequence(conn, org_id, target_id, destination_type_id)

        # 4. Record the graduation event
        event = await GraduationQueries.record_graduation(
            conn=conn,
            org_id=org_id,
            target_id=target_id,
            source_target_type_id=source_type_id,
            destination_target_type_id=destination_type_id,
            rule_id=rule_id,
            manual=user_id is not None and rule_id is None,
            triggered_by_user_id=user_id,
        )

        logger.info(
            f"Graduated target {target_id}: {source_type_id} -> {destination_type_id}",
            extra={"org_id": org_id, "rule_id": str(rule_id) if rule_id else None}
        )

        return event


async def evaluate_and_graduate(
    conn: asyncpg.Connection,
    org_id: str,
    target_id: UUID,
) -> Optional[dict[str, Any]]:
    """Evaluate graduation rules for a target and graduate if matched.

    Returns the graduation event if graduated, None if no rules matched.
    Raises GraduationError on failures (does not silently return None).
    """
    target = await TargetQueries.get_by_id(conn, target_id)

    if not target:
        raise TargetNotFoundError(f"Target not found: {target_id}")

    if str(target.get("organization_id")) != org_id:
        raise UnauthorizedError(f"Target {target_id} does not belong to organization")

    rule = await find_matching_rule(conn, org_id, target)

    if not rule:
        return None

    return await graduate(
        conn=conn,
        org_id=org_id,
        target_id=target_id,
        destination_type_id=rule["destination_target_type_id"],
        rule_id=rule["id"],
    )
```

### Phase 3: API Endpoints

**Files to create/modify:**

| File | Purpose |
|------|---------|
| `functions/api/app/schemas.py` | Add graduation schemas |
| `functions/api/app/routers/graduation_rules.py` | Rule CRUD endpoints |
| `functions/api/app/routers/targets.py` | Add graduation endpoint |
| `functions/api/app/main.py` | Register router |

**Schemas: Add to `functions/api/app/schemas.py`**

```python
from typing import Any, Optional, Literal
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, Field, field_validator


class RuleCondition(BaseModel):
    field: str = Field(..., min_length=1, max_length=100)
    operator: Literal["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"]
    value: Optional[Any] = None

    @field_validator('field')
    @classmethod
    def validate_field(cls, v: str) -> str:
        if '__' in v or v.startswith('_'):
            raise ValueError("Invalid field name")
        if v.count('.') > 2:  # MAX_FIELD_DEPTH - 1
            raise ValueError("Field path too deep")
        return v


class GraduationRuleCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    source_target_type_id: UUID
    destination_target_type_id: UUID
    conditions: list[RuleCondition] = Field(..., min_length=1, max_length=20)
    enabled: bool = True


class GraduationRuleUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    conditions: Optional[list[RuleCondition]] = None
    enabled: Optional[bool] = None


class GraduationRuleResponse(BaseModel):
    id: UUID
    organization_id: UUID
    source_target_type_id: UUID
    destination_target_type_id: UUID
    source_type_name: Optional[str] = None
    destination_type_name: Optional[str] = None
    name: str
    description: Optional[str]
    conditions: list[dict[str, Any]]
    enabled: bool
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ManualGraduationRequest(BaseModel):
    destination_target_type_id: UUID


class GraduationEventResponse(BaseModel):
    id: UUID
    target_id: Optional[UUID]
    rule_id: Optional[UUID]
    source_target_type_id: UUID
    destination_target_type_id: UUID
    manual: bool
    triggered_by_user_id: Optional[UUID]
    created_at: datetime

    model_config = {"from_attributes": True}
```

**Router: `functions/api/app/routers/graduation_rules.py`**

```python
"""Graduation rules API endpoints."""

from typing import Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status

from ..schemas import (
    GraduationRuleCreate,
    GraduationRuleUpdate,
    GraduationRuleResponse,
)
from ..dependencies import DBConnection, get_current_org_id
from shared.queries.graduation import GraduationQueries

router = APIRouter(prefix="/graduation-rules", tags=["graduation-rules"])


@router.get("", response_model=list[GraduationRuleResponse])
async def list_graduation_rules(
    source_target_type_id: Optional[UUID] = None,
    enabled: Optional[bool] = None,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> list[GraduationRuleResponse]:
    """List graduation rules for the organization."""
    rules = await GraduationQueries.list_rules(
        db, org_id, source_target_type_id=source_target_type_id, enabled=enabled
    )
    return [GraduationRuleResponse(**r) for r in rules]


@router.post("", response_model=GraduationRuleResponse, status_code=status.HTTP_201_CREATED)
async def create_graduation_rule(
    data: GraduationRuleCreate,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> GraduationRuleResponse:
    """Create a new graduation rule."""
    # Validate source != destination
    if data.source_target_type_id == data.destination_target_type_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Source and destination target types must be different"
        )

    # Validate both target types belong to organization
    source_type = await db.fetchrow(
        "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
        data.source_target_type_id, org_id
    )
    if not source_type:
        raise HTTPException(status_code=400, detail="Invalid source target type")

    dest_type = await db.fetchrow(
        "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
        data.destination_target_type_id, org_id
    )
    if not dest_type:
        raise HTTPException(status_code=400, detail="Invalid destination target type")

    # Check for cycles (app-level, not DB trigger)
    if data.enabled:
        has_cycle = await GraduationQueries.check_for_cycle(
            db, org_id, data.source_target_type_id, data.destination_target_type_id
        )
        if has_cycle:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This rule would create a circular graduation path"
            )

    rule = await GraduationQueries.create_rule(
        db,
        org_id=org_id,
        source_target_type_id=data.source_target_type_id,
        destination_target_type_id=data.destination_target_type_id,
        name=data.name,
        description=data.description,
        conditions=[c.model_dump() for c in data.conditions],
        enabled=data.enabled,
    )
    return GraduationRuleResponse(**rule)


@router.get("/{rule_id}", response_model=GraduationRuleResponse)
async def get_graduation_rule(
    rule_id: UUID,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> GraduationRuleResponse:
    """Get a graduation rule by ID."""
    rule = await GraduationQueries.get_rule(db, org_id, rule_id)
    if not rule:
        raise HTTPException(status_code=404, detail="Graduation rule not found")
    return GraduationRuleResponse(**rule)


@router.patch("/{rule_id}", response_model=GraduationRuleResponse)
async def update_graduation_rule(
    rule_id: UUID,
    data: GraduationRuleUpdate,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> GraduationRuleResponse:
    """Update a graduation rule."""
    existing = await GraduationQueries.get_rule(db, org_id, rule_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Graduation rule not found")

    update_data = data.model_dump(exclude_unset=True)
    if "conditions" in update_data and data.conditions:
        update_data["conditions"] = [c.model_dump() for c in data.conditions]

    # Check for cycles if enabling
    if update_data.get("enabled", existing["enabled"]):
        has_cycle = await GraduationQueries.check_for_cycle(
            db, org_id,
            existing["source_target_type_id"],
            existing["destination_target_type_id"],
            exclude_rule_id=rule_id
        )
        if has_cycle:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Enabling this rule would create a circular graduation path"
            )

    rule = await GraduationQueries.update_rule(db, org_id, rule_id, **update_data)
    return GraduationRuleResponse(**rule)


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_graduation_rule(
    rule_id: UUID,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> None:
    """Delete a graduation rule."""
    deleted = await GraduationQueries.delete_rule(db, org_id, rule_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Graduation rule not found")
```

**Add to targets router: `functions/api/app/routers/targets.py`**

```python
# Add this endpoint to existing targets.py router

from ..schemas import ManualGraduationRequest, GraduationEventResponse


@router.post("/{target_id}/graduate", response_model=GraduationEventResponse)
async def graduate_target(
    target_id: UUID,
    data: ManualGraduationRequest,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
    user_id: UUID = Depends(get_current_user_id),
) -> GraduationEventResponse:
    """Manually graduate a target to a new target type."""
    from shared.graduation import graduate, GraduationError, TargetNotFoundError, UnauthorizedError

    try:
        event = await graduate(
            db, org_id, target_id, data.destination_target_type_id, user_id=user_id
        )
        return GraduationEventResponse(**event)
    except TargetNotFoundError:
        raise HTTPException(status_code=404, detail="Target not found")
    except UnauthorizedError:
        raise HTTPException(status_code=404, detail="Target not found")  # Don't reveal existence
    except GraduationError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

### Phase 4: Integration with Target Updates

**Modify: `functions/api/app/routers/targets.py`**

```python
# Modify the existing update_target endpoint to trigger graduation evaluation

@router.patch("/{target_id}", response_model=TargetResponse)
async def update_target(
    target_id: UUID,
    data: TargetUpdate,
    db: DBConnection = Depends(),
    org_id: str = Depends(get_current_org_id),
) -> TargetResponse:
    """Update a target and evaluate graduation rules."""
    existing = await TargetQueries.get_by_id(db, target_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Target not found")

    if str(existing.get("organization_id")) != org_id:
        raise HTTPException(status_code=404, detail="Target not found")

    update_data = data.model_dump(exclude_unset=True)

    # Check if graduation-relevant fields changed
    graduation_fields = {"lifecycle_stage", "custom_fields", "metadata", "status"}
    should_evaluate_graduation = (
        any(f in update_data for f in graduation_fields) and
        existing.get("target_type_id")
    )

    # Update the target
    target = await TargetQueries.update(db, target_id, **update_data)

    # Evaluate graduation rules if relevant fields changed
    if should_evaluate_graduation:
        from shared.graduation import evaluate_and_graduate, GraduationError
        try:
            result = await evaluate_and_graduate(db, org_id, target_id)
            if result:
                # Refetch target since type may have changed
                target = await TargetQueries.get_by_id(db, target_id)
        except GraduationError as e:
            # Log but don't fail the update
            logger.warning(f"Graduation evaluation failed for {target_id}: {e}")

    return TargetResponse(**target)
```

---

## Acceptance Criteria

### Functional Requirements

- [ ] Graduation rules can be created, read, updated, and deleted via API
- [ ] Rules support field conditions with operators: eq, ne, gt, gte, lt, lte, contains, exists
- [ ] All conditions must match (implicit AND) for rule to trigger
- [ ] Rules are evaluated when graduation-relevant target fields are updated
- [ ] First matching rule (by creation order) triggers graduation
- [ ] Graduation exits all active sequence enrollments
- [ ] Graduation auto-enrolls target in default sequences for new type
- [ ] Manual graduation is available via API endpoint
- [ ] Graduation events are recorded for audit
- [ ] Circular graduation paths are prevented at rule creation time

### Non-Functional Requirements

- [ ] Rule evaluation completes within 100ms for typical targets
- [ ] Graduation transaction is atomic (all-or-nothing)
- [ ] Security: Only allowed fields can be accessed in rules
- [ ] Errors are raised explicitly, not returned as None

### Quality Gates

- [ ] Unit tests for condition evaluation with all operators
- [ ] Unit tests for field access security validation
- [ ] Integration tests for graduation flow
- [ ] API endpoint tests for rule CRUD
- [ ] Test for circular path detection

---

## Files Summary

| Phase | File | Action |
|-------|------|--------|
| 1 | `migrations/027_graduation_rules.sql` | Create |
| 1 | `layers/shared/shared/queries/graduation.py` | Create |
| 2 | `layers/shared/shared/graduation.py` | Create |
| 3 | `functions/api/app/schemas.py` | Modify |
| 3 | `functions/api/app/routers/graduation_rules.py` | Create |
| 3 | `functions/api/app/routers/targets.py` | Modify |
| 3 | `functions/api/app/main.py` | Modify |

**Total new files:** 4
**Total modified files:** 3
**Estimated LOC:** ~400 (down from ~1400)

---

## Future Enhancements (Phase 2+)

These were explicitly removed from Phase 1 per YAGNI. Add only when needed:

- [ ] Bulk graduation endpoint
- [ ] Preview/dry-run endpoint
- [ ] Rule testing endpoint
- [ ] Priority ordering for rules
- [ ] Idempotency keys for retry safety
- [ ] Optimistic locking with version column
- [ ] Background async graduation evaluation
- [ ] Caching for rule lookups

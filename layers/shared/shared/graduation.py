"""Functions for evaluating and executing target graduations."""

import logging
from typing import Any, Optional
from uuid import UUID

import asyncpg

from .queries.graduation import GraduationQueries
from .queries.targets import TargetQueries, auto_enroll_in_default_sequence

logger = logging.getLogger(__name__)

# Security: Allowlist of fields that can be used in rule conditions
ALLOWED_ROOT_FIELDS = frozenset(
    {
        "status",
        "lifecycle_stage",
        "email",
        "first_name",
        "last_name",
        "company",
        "phone",
        "title",
        "industry",
        "custom_fields",
        "metadata",
    }
)
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
        if part.startswith("_"):
            raise InvalidRuleError(f"Private field access forbidden: {part}")

    # Traverse the path
    current: Any = target
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

    # Handle None consistently - exists check
    if operator == "exists":
        return actual is not None

    # For all other operators, None means condition fails
    if actual is None:
        return False

    if operator == "eq":
        return actual == expected
    elif operator == "ne":
        return actual != expected
    elif operator == "gt":
        return (
            isinstance(actual, (int, float))
            and isinstance(expected, (int, float))
            and actual > expected
        )
    elif operator == "gte":
        return (
            isinstance(actual, (int, float))
            and isinstance(expected, (int, float))
            and actual >= expected
        )
    elif operator == "lt":
        return (
            isinstance(actual, (int, float))
            and isinstance(expected, (int, float))
            and actual < expected
        )
    elif operator == "lte":
        return (
            isinstance(actual, (int, float))
            and isinstance(expected, (int, float))
            and actual <= expected
        )
    elif operator == "contains":
        if isinstance(actual, str):
            return isinstance(expected, str) and expected in actual
        elif isinstance(actual, list):
            return expected in actual
        return False
    else:
        raise InvalidRuleError(f"Unknown operator: {operator}")


def evaluate_conditions(
    conditions: list[dict[str, Any]], target: dict[str, Any]
) -> bool:
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

    rules = await GraduationQueries.get_rules_for_target_type(
        conn, org_id, target_type_id
    )

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
            target_id,
        )

        if not target:
            raise TargetNotFoundError(f"Target not found: {target_id}")

        if str(target["organization_id"]) != org_id:
            raise UnauthorizedError(
                f"Target {target_id} does not belong to organization"
            )

        source_type_id = target["target_type_id"]

        if source_type_id == destination_type_id:
            raise GraduationError("Target is already in the destination type")

        # Verify destination type exists and belongs to org
        dest_type = await conn.fetchrow(
            "SELECT id FROM target_types WHERE id = $1 AND organization_id = $2",
            destination_type_id,
            org_id,
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
            org_id,
            target_id,
        )
        exited_count = int(exit_result.split()[-1]) if exit_result else 0
        logger.info(f"Exited {exited_count} enrollments for target {target_id}")

        # 2. Update target type
        await conn.execute(
            "UPDATE targets SET target_type_id = $1, updated_at = NOW() WHERE id = $2",
            destination_type_id,
            target_id,
        )

        # 3. Auto-enroll in default sequences for new type
        await auto_enroll_in_default_sequence(
            conn, org_id, target_id, destination_type_id
        )

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
            extra={"org_id": org_id, "rule_id": str(rule_id) if rule_id else None},
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

"""Tests for graduation rules and condition evaluation."""

import pytest
from pydantic import ValidationError
from uuid import UUID

from app.schemas import (
    GraduationRuleCreate,
    GraduationRuleUpdate,
    ManualGraduationRequest,
    RuleCondition,
)
from shared.graduation import (
    ALLOWED_ROOT_FIELDS,
    InvalidRuleError,
    _evaluate_condition,
    _get_field_value,
    evaluate_conditions,
)


class TestRuleConditionSchema:
    """Tests for RuleCondition schema validation."""

    def test_valid_condition(self):
        """Test valid condition."""
        condition = RuleCondition(field="status", operator="eq", value="active")
        assert condition.field == "status"
        assert condition.operator == "eq"
        assert condition.value == "active"

    def test_valid_operators(self):
        """Test all valid operators."""
        for op in ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"]:
            condition = RuleCondition(field="status", operator=op, value="test")
            assert condition.operator == op

    def test_invalid_operator(self):
        """Test invalid operator is rejected."""
        with pytest.raises(ValidationError):
            RuleCondition(field="status", operator="invalid", value="test")

    def test_empty_field_rejected(self):
        """Test empty field is rejected."""
        with pytest.raises(ValidationError):
            RuleCondition(field="", operator="eq", value="test")

    def test_exists_without_value(self):
        """Test exists operator can have None value."""
        condition = RuleCondition(field="metadata.score", operator="exists", value=None)
        assert condition.operator == "exists"
        assert condition.value is None


class TestGraduationRuleCreateSchema:
    """Tests for GraduationRuleCreate schema."""

    def test_valid_rule(self):
        """Test valid rule creation."""
        rule = GraduationRuleCreate(
            name="Prospect to Lead",
            source_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
            destination_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440002"),
            conditions=[
                RuleCondition(field="lifecycle_stage", operator="gte", value=2),
            ],
        )
        assert rule.name == "Prospect to Lead"
        assert rule.enabled is True
        assert len(rule.conditions) == 1

    def test_empty_name_rejected(self):
        """Test empty name is rejected."""
        with pytest.raises(ValidationError):
            GraduationRuleCreate(
                name="",
                source_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
                destination_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440002"),
                conditions=[RuleCondition(field="status", operator="eq", value="active")],
            )

    def test_empty_conditions_rejected(self):
        """Test empty conditions list is rejected."""
        with pytest.raises(ValidationError):
            GraduationRuleCreate(
                name="Test Rule",
                source_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
                destination_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440002"),
                conditions=[],
            )

    def test_multiple_conditions(self):
        """Test rule with multiple conditions."""
        rule = GraduationRuleCreate(
            name="Complex Rule",
            source_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
            destination_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440002"),
            conditions=[
                RuleCondition(field="lifecycle_stage", operator="gte", value=3),
                RuleCondition(field="status", operator="eq", value="active"),
                RuleCondition(field="metadata.score", operator="gt", value=80),
            ],
        )
        assert len(rule.conditions) == 3


class TestManualGraduationRequestSchema:
    """Tests for ManualGraduationRequest schema."""

    def test_valid_request(self):
        """Test valid manual graduation request."""
        request = ManualGraduationRequest(
            destination_target_type_id=UUID("550e8400-e29b-41d4-a716-446655440001"),
        )
        assert request.destination_target_type_id == UUID(
            "550e8400-e29b-41d4-a716-446655440001"
        )


class TestGetFieldValue:
    """Tests for _get_field_value function."""

    def test_simple_field(self):
        """Test accessing simple field."""
        target = {"status": "active", "lifecycle_stage": 2}
        assert _get_field_value(target, "status") == "active"
        assert _get_field_value(target, "lifecycle_stage") == 2

    def test_nested_field(self):
        """Test accessing nested field with dot notation."""
        target = {
            "metadata": {"score": 85, "grade": "A"},
            "custom_fields": {"industry": "Tech"},
        }
        assert _get_field_value(target, "metadata.score") == 85
        assert _get_field_value(target, "custom_fields.industry") == "Tech"

    def test_deeply_nested_field(self):
        """Test accessing deeply nested field."""
        target = {"metadata": {"details": {"level": 3}}}
        assert _get_field_value(target, "metadata.details.level") == 3

    def test_missing_field_returns_none(self):
        """Test missing field returns None."""
        target = {"status": "active"}
        assert _get_field_value(target, "lifecycle_stage") is None

    def test_missing_nested_field_returns_none(self):
        """Test missing nested field returns None."""
        target = {"metadata": {}}
        assert _get_field_value(target, "metadata.score") is None

    def test_disallowed_field_raises(self):
        """Test accessing disallowed field raises error."""
        target = {"id": "123", "status": "active"}
        with pytest.raises(InvalidRuleError, match="Field not allowed"):
            _get_field_value(target, "id")

    def test_too_deep_field_raises(self):
        """Test field path too deep raises error."""
        target = {"metadata": {"a": {"b": {"c": {"d": 1}}}}}
        with pytest.raises(InvalidRuleError, match="Field path too deep"):
            _get_field_value(target, "metadata.a.b.c.d")

    def test_private_field_raises(self):
        """Test private field access raises error."""
        target = {"metadata": {"_internal": "secret"}}
        with pytest.raises(InvalidRuleError, match="Private field access forbidden"):
            _get_field_value(target, "metadata._internal")


class TestEvaluateCondition:
    """Tests for _evaluate_condition function."""

    def test_eq_operator(self):
        """Test equality operator."""
        target = {"status": "active"}
        assert _evaluate_condition(
            {"field": "status", "operator": "eq", "value": "active"}, target
        )
        assert not _evaluate_condition(
            {"field": "status", "operator": "eq", "value": "inactive"}, target
        )

    def test_ne_operator(self):
        """Test not equal operator."""
        target = {"status": "active"}
        assert _evaluate_condition(
            {"field": "status", "operator": "ne", "value": "inactive"}, target
        )
        assert not _evaluate_condition(
            {"field": "status", "operator": "ne", "value": "active"}, target
        )

    def test_gt_operator(self):
        """Test greater than operator."""
        target = {"lifecycle_stage": 3}
        assert _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "gt", "value": 2}, target
        )
        assert not _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "gt", "value": 3}, target
        )

    def test_gte_operator(self):
        """Test greater than or equal operator."""
        target = {"lifecycle_stage": 3}
        assert _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "gte", "value": 3}, target
        )
        assert not _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "gte", "value": 4}, target
        )

    def test_lt_operator(self):
        """Test less than operator."""
        target = {"lifecycle_stage": 2}
        assert _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "lt", "value": 3}, target
        )
        assert not _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "lt", "value": 2}, target
        )

    def test_lte_operator(self):
        """Test less than or equal operator."""
        target = {"lifecycle_stage": 2}
        assert _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "lte", "value": 2}, target
        )
        assert not _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "lte", "value": 1}, target
        )

    def test_contains_operator_string(self):
        """Test contains operator with string."""
        target = {"company": "Acme Corporation"}
        assert _evaluate_condition(
            {"field": "company", "operator": "contains", "value": "Acme"}, target
        )
        assert not _evaluate_condition(
            {"field": "company", "operator": "contains", "value": "Google"}, target
        )

    def test_contains_operator_list(self):
        """Test contains operator with list."""
        target = {"custom_fields": {"tags": ["vip", "enterprise"]}}
        assert _evaluate_condition(
            {"field": "custom_fields.tags", "operator": "contains", "value": "vip"},
            target,
        )
        assert not _evaluate_condition(
            {"field": "custom_fields.tags", "operator": "contains", "value": "free"},
            target,
        )

    def test_exists_operator(self):
        """Test exists operator."""
        target = {"metadata": {"score": 85}}
        assert _evaluate_condition(
            {"field": "metadata.score", "operator": "exists", "value": None}, target
        )
        assert not _evaluate_condition(
            {"field": "metadata.grade", "operator": "exists", "value": None}, target
        )

    def test_none_field_fails_non_exists_operators(self):
        """Test that None field value fails non-exists operators."""
        target = {"status": "active"}  # no lifecycle_stage
        assert not _evaluate_condition(
            {"field": "lifecycle_stage", "operator": "eq", "value": 0}, target
        )


class TestEvaluateConditions:
    """Tests for evaluate_conditions function (implicit AND)."""

    def test_all_conditions_true(self):
        """Test all conditions pass."""
        target = {"status": "active", "lifecycle_stage": 3, "metadata": {"score": 90}}
        conditions = [
            {"field": "status", "operator": "eq", "value": "active"},
            {"field": "lifecycle_stage", "operator": "gte", "value": 2},
            {"field": "metadata.score", "operator": "gt", "value": 80},
        ]
        assert evaluate_conditions(conditions, target)

    def test_one_condition_false(self):
        """Test one failing condition fails all."""
        target = {"status": "active", "lifecycle_stage": 1}
        conditions = [
            {"field": "status", "operator": "eq", "value": "active"},
            {"field": "lifecycle_stage", "operator": "gte", "value": 2},  # fails
        ]
        assert not evaluate_conditions(conditions, target)

    def test_empty_conditions_returns_false(self):
        """Test empty conditions list returns False."""
        target = {"status": "active"}
        assert not evaluate_conditions([], target)

    def test_single_condition(self):
        """Test single condition evaluation."""
        target = {"status": "active"}
        conditions = [{"field": "status", "operator": "eq", "value": "active"}]
        assert evaluate_conditions(conditions, target)


class TestAllowedRootFields:
    """Tests for security allowlist."""

    def test_allowed_fields_are_defined(self):
        """Test that expected fields are in the allowlist."""
        expected = {
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
        assert expected == ALLOWED_ROOT_FIELDS

    def test_sensitive_fields_not_allowed(self):
        """Test that sensitive fields are not in the allowlist."""
        sensitive = {"id", "organization_id", "target_type_id", "created_at", "updated_at"}
        assert not sensitive.intersection(ALLOWED_ROOT_FIELDS)

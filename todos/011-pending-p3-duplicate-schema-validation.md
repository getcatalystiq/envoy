---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, python, dry]
dependencies: []
---

# Duplicate Field Validation in Schema and Runtime

## Problem Statement

The `RuleCondition.validate_field()` in schemas.py duplicates validation already performed in `_get_field_value()` in graduation.py. This creates two places to maintain the same rules.

**Why it matters:** Violates DRY principle, risk of rules getting out of sync.

## Findings

**Source:** code-simplicity-reviewer agent

**Location:**
- `/Users/marmarko/code/envoy/functions/api/app/schemas.py` lines 690-697
- `/Users/marmarko/code/envoy/layers/shared/shared/graduation.py` lines 65-75

**Duplicate Logic:**
- Both check for `__` in field names
- Both check for leading `_`
- Both check depth (count of `.` > 2)

## Proposed Solutions

### Option A: Remove Schema Validator (Recommended)
**Pros:** Single source of truth in runtime
**Cons:** Validation error happens later in request lifecycle
**Effort:** Small
**Risk:** Low

### Option B: Import Constants from graduation.py
**Pros:** Keeps early validation
**Cons:** Creates cross-layer dependency
**Effort:** Small
**Risk:** Low

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `functions/api/app/schemas.py`

## Acceptance Criteria

- [ ] Field validation exists in only one place
- [ ] Invalid fields still rejected with clear error

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | DRY principle |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

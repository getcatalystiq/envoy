---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, security, sql-injection]
dependencies: []
---

# Dynamic SQL Column Name Construction Without Validation

## Problem Statement

The `update_rule` method dynamically builds column names from dictionary keys without validation. While values are parameterized, column names are injected directly into the query string.

**Why it matters:** If a code path passes unvalidated keys, SQL injection is possible.

## Findings

**Source:** security-sentinel agent, data-migration-expert agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/queries/graduation.py` lines 119-126

**Vulnerable Code:**
```python
for key, value in updates.items():
    if key == "conditions":
        set_clauses.append(f"{key} = ${len(params) + 1}::jsonb")
    else:
        set_clauses.append(f"{key} = ${len(params) + 1}")  # key directly interpolated
```

**Current Mitigation:** Router uses `data.model_dump(exclude_unset=True)` limiting keys to Pydantic schema fields.

**Risk:** Defense-in-depth gap. If schema validation is bypassed or changed, injection is possible.

## Proposed Solutions

### Option A: Add Column Allowlist (Recommended)
**Pros:** Defense in depth, explicit validation
**Cons:** Must keep allowlist in sync with schema
**Effort:** Small
**Risk:** Low

```python
ALLOWED_UPDATE_COLUMNS = frozenset({"name", "description", "conditions", "enabled"})

for key, value in updates.items():
    if key not in ALLOWED_UPDATE_COLUMNS:
        raise ValueError(f"Invalid column: {key}")
    # ... rest of logic
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/queries/graduation.py`

## Acceptance Criteria

- [ ] Column allowlist validates all update keys
- [ ] Invalid column names raise ValueError
- [ ] Same pattern applied to TargetQueries.update if affected

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Defense in depth for SQL |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

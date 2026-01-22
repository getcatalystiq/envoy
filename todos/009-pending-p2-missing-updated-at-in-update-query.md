---
status: pending
priority: p2
issue_id: "009"
tags: [code-review, database, consistency]
dependencies: []
---

# Missing updated_at in update_rule Query

## Problem Statement

The `update_rule` method does not explicitly set `updated_at`. While the database trigger handles this, relying on triggers when other parts of the codebase set `updated_at` explicitly is inconsistent.

**Why it matters:** Inconsistent patterns make code harder to understand and maintain.

## Findings

**Source:** kieran-python-reviewer agent, pattern-recognition-specialist agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/queries/graduation.py` lines 127-135

**Current Code:**
```python
query = f"""
    UPDATE graduation_rules
    SET {", ".join(set_clauses)}
    WHERE id = $1 AND organization_id = $2
    RETURNING *
"""
```

**Comparison:** `TargetQueries.update` includes `updated_at = NOW()` explicitly.

## Proposed Solutions

### Option A: Add updated_at to SET Clause (Recommended)
**Pros:** Consistent with other update methods
**Cons:** Redundant with trigger
**Effort:** Small
**Risk:** Low

```python
set_clauses.append("updated_at = NOW()")
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/queries/graduation.py`

## Acceptance Criteria

- [ ] `update_rule` explicitly sets `updated_at = NOW()`
- [ ] Pattern matches other update methods in codebase

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Consistency with existing patterns |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

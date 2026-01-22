---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, python, style]
dependencies: []
---

# Use Modern Union Syntax Instead of Optional

## Problem Statement

The code uses `Optional[X]` instead of the modern Python 3.10+ `X | None` syntax.

**Why it matters:** Python style conventions have evolved; modern syntax is more readable.

## Findings

**Source:** kieran-python-reviewer agent

**Location:** Multiple files in the PR

**Current:**
```python
from typing import Optional
source_target_type_id: Optional[UUID] = None
```

**Modern:**
```python
source_target_type_id: UUID | None = None
```

## Proposed Solutions

### Option A: Update to Modern Syntax
**Pros:** Modern Python style
**Cons:** Requires Python 3.10+
**Effort:** Small
**Risk:** Low (verify Python version)

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `functions/api/app/routers/graduation_rules.py`
- `layers/shared/shared/graduation.py`
- `layers/shared/shared/queries/graduation.py`

## Acceptance Criteria

- [ ] `Optional[X]` replaced with `X | None`
- [ ] `from typing import Optional` removed where no longer needed

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Python 3.10+ type hints |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

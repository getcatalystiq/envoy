---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, python, code-quality]
dependencies: []
---

# Imports Inside Function Bodies

## Problem Statement

The graduation module is imported inline within route handlers rather than at module top. This is a code smell that increases cognitive load and may indicate coupling issues.

**Why it matters:** Scattered imports make code harder to understand, and inline imports have minor first-request performance penalty.

## Findings

**Source:** kieran-python-reviewer agent, architecture-strategist agent

**Location:** `/Users/marmarko/code/envoy/functions/api/app/routers/targets.py` lines 193-194, 227-232

**Code:**
```python
async def update_target(...):
    if should_evaluate_graduation:
        from shared.graduation import GraduationError, evaluate_and_graduate  # Inline import

async def graduate_target(...):
    from shared.graduation import (  # Inline import
        GraduationError, TargetNotFoundError, UnauthorizedError, graduate,
    )
```

## Proposed Solutions

### Option A: Move Imports to Module Top (Recommended)
**Pros:** Cleaner code, standard Python style
**Cons:** May reveal circular import issues
**Effort:** Small
**Risk:** Low (test to verify no circular imports)

```python
# At top of file
from shared.graduation import (
    GraduationError,
    TargetNotFoundError,
    UnauthorizedError,
    evaluate_and_graduate,
    graduate,
)
```

### Option B: Document Why Inline Import is Needed
**Pros:** Explains intentional choice
**Cons:** Leaves code smell in place
**Effort:** Minimal
**Risk:** None

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `functions/api/app/routers/targets.py`

## Acceptance Criteria

- [ ] Imports moved to module top OR reason documented
- [ ] No circular import errors
- [ ] All tests pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Python style conventions |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6
- PEP 8: https://peps.python.org/pep-0008/#imports

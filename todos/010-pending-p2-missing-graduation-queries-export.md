---
status: pending
priority: p2
issue_id: "010"
tags: [code-review, python, architecture]
dependencies: []
---

# GraduationQueries Not Exported from queries Package

## Problem Statement

`GraduationQueries` is not exported from the queries package `__init__.py`, breaking the established pattern for other query classes. This forces direct imports rather than package-level imports.

**Why it matters:** Inconsistent import patterns, breaks expectations for developers.

## Findings

**Source:** architecture-strategist agent, pattern-recognition-specialist agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/queries/__init__.py`

**Current Pattern (inconsistent):**
```python
from shared.queries.graduation import GraduationQueries  # Direct import required
```

**Expected Pattern:**
```python
from shared.queries import GraduationQueries  # Package-level import
```

## Proposed Solutions

### Option A: Add to __init__.py Exports (Recommended)
**Pros:** Consistent with other query classes
**Cons:** None
**Effort:** Minimal
**Risk:** None

```python
from shared.queries.graduation import GraduationQueries

__all__ = [
    "TargetQueries",
    "ContentQueries",
    "CampaignQueries",
    "OutboxQueries",
    "SequenceQueries",
    "GraduationQueries",  # Add this
]
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/queries/__init__.py`

## Acceptance Criteria

- [ ] `GraduationQueries` exported from `shared.queries`
- [ ] Import `from shared.queries import GraduationQueries` works

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Package export consistency |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

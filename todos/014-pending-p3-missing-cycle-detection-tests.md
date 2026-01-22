---
status: pending
priority: p3
issue_id: "014"
tags: [code-review, testing]
dependencies: []
---

# Missing Tests for Cycle Detection

## Problem Statement

There are no tests for `GraduationQueries.check_for_cycle()`. This is a critical function that prevents infinite graduation loops.

**Why it matters:** Critical functionality without test coverage increases regression risk.

## Findings

**Source:** kieran-python-reviewer agent

**Location:** `/Users/marmarko/code/envoy/tests/unit/test_graduation.py` - cycle detection tests missing

## Proposed Solutions

### Option A: Add Integration Tests for Cycle Detection
**Pros:** Ensures critical logic is covered
**Cons:** Requires database or mocking
**Effort:** Medium
**Risk:** Low

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `tests/unit/test_graduation.py` or new integration test file

## Acceptance Criteria

- [ ] Test: Simple cycle A -> B -> A detected
- [ ] Test: Multi-hop cycle A -> B -> C -> A detected
- [ ] Test: No false positives for valid paths

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Test coverage gap |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

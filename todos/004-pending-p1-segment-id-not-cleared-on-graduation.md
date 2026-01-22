---
status: pending
priority: p1
issue_id: "004"
tags: [code-review, data-integrity, referential-integrity]
dependencies: []
---

# segment_id Not Cleared on Graduation Creates Referential Inconsistency

## Problem Statement

When a target graduates to a new type, the `segment_id` on the target is not cleared. Since segments are scoped to target types, this creates an invalid reference where the target belongs to type "Customer" but references a segment that belongs to type "Lead".

**Why it matters:** Queries and business logic that rely on segment membership will produce incorrect results.

## Findings

**Source:** data-integrity-guardian agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/graduation.py` lines 241-245

**Current Code:**
```python
# 2. Update target type
await conn.execute(
    "UPDATE targets SET target_type_id = $1, updated_at = NOW() WHERE id = $2",
    destination_type_id,
    target_id,
)
```

**Data Corruption Example:**
1. Target is type "Lead" with segment "Film Production" (which belongs to "Lead")
2. Target graduates to type "Customer"
3. Target now has type="Customer" but segment="Film Production" (belongs to "Lead")
4. Segment queries for "Customer" won't find this target, but it's not in any Customer segment

## Proposed Solutions

### Option A: Clear segment_id on Graduation (Recommended)
**Pros:** Simple, prevents invalid state
**Cons:** Target loses segment assignment
**Effort:** Small (1 line change)
**Risk:** Low

```python
await conn.execute(
    "UPDATE targets SET target_type_id = $1, segment_id = NULL, updated_at = NOW() WHERE id = $2",
    destination_type_id,
    target_id,
)
```

### Option B: Map Segments Between Types
**Pros:** Preserves segment context
**Cons:** Complex, requires segment mapping table
**Effort:** Large
**Risk:** Medium

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/graduation.py`

## Acceptance Criteria

- [ ] After graduation, target's segment_id is NULL
- [ ] No targets exist with segment_id pointing to wrong target_type
- [ ] Documentation updated to explain segment clearing behavior

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Segments are scoped to target types |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

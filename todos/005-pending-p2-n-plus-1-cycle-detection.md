---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, performance, n-plus-1, database]
dependencies: []
---

# N+1 Query Pattern in Cycle Detection Algorithm

## Problem Statement

The `check_for_cycle` function performs a database query for each node visited in the DFS traversal. For organizations with many target types and rules, this could result in dozens of queries per rule creation/update.

**Why it matters:** Rule creation latency scales linearly with the number of target types, potentially causing timeouts.

## Findings

**Source:** performance-oracle agent, pattern-recognition-specialist agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/queries/graduation.py` lines 218-244

**Problematic Code:**
```python
while stack:
    current = stack.pop()
    # ...
    # DATABASE QUERY INSIDE LOOP - N+1 PATTERN
    rows = await conn.fetch(
        """SELECT destination_target_type_id FROM graduation_rules...""",
        org_id, current, exclude_rule_id,
    )
```

**Projected Impact:**
- 10 target types: ~10 queries per cycle check
- 50 target types: ~50 queries per cycle check
- With 50 types: latency could reach 2 seconds

## Proposed Solutions

### Option A: Pre-fetch All Rules, DFS In-Memory (Recommended)
**Pros:** O(1) queries instead of O(n)
**Cons:** Loads all rules into memory (typically small)
**Effort:** Medium
**Risk:** Low

```python
async def check_for_cycle(...) -> bool:
    # Single query to fetch all edges
    rows = await conn.fetch(
        """SELECT source_target_type_id, destination_target_type_id
           FROM graduation_rules
           WHERE organization_id = $1 AND enabled = TRUE
           AND ($2::uuid IS NULL OR id != $2)""",
        org_id, exclude_rule_id,
    )

    # Build adjacency list in memory
    graph: dict[UUID, list[UUID]] = {}
    for row in rows:
        graph.setdefault(row["source_target_type_id"], []).append(row["destination_target_type_id"])

    # DFS entirely in memory
    visited: set[UUID] = set()
    stack = [destination_type_id]
    while stack:
        current = stack.pop()
        if current == source_type_id:
            return True
        if current in visited:
            continue
        visited.add(current)
        stack.extend(graph.get(current, []))
    return False
```

### Option B: Recursive CTE
**Pros:** Single query, database handles traversal
**Cons:** More complex SQL
**Effort:** Medium
**Risk:** Medium

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/queries/graduation.py`

## Acceptance Criteria

- [ ] Cycle detection uses O(1) database queries
- [ ] Performance test: < 50ms for 50 target types

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Classic N+1 pattern |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

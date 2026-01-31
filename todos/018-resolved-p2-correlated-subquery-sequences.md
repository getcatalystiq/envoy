---
status: complete
priority: p2
issue_id: "018"
tags: [code-review, performance, mcp]
dependencies: []
---

# Correlated Subquery in get_sequences Tool

## Problem Statement

The `_tool_get_sequences` function uses a correlated subquery `(SELECT COUNT(*) FROM sequence_steps WHERE sequence_id = s.id)` that executes once per sequence. With 100 sequences, this results in 100+ subqueries.

**Why it matters:** Query time grows linearly with sequence count, causing timeouts at scale.

## Findings

### Current Query (lines 1297-1332):

```sql
SELECT
    s.id, s.name, ...
    (SELECT COUNT(*) FROM sequence_steps WHERE sequence_id = s.id) as step_count,
    COUNT(e.id) FILTER (WHERE e.status = 'active') as active_enrollments,
    ...
FROM sequences s
LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
WHERE s.organization_id = $1
GROUP BY s.id
```

### Performance Impact:

| Sequences | Subqueries | Latency |
|-----------|------------|---------|
| 10 | 10 | ~30ms |
| 50 | 50 | ~150ms |
| 200 | 200 | ~600ms |
| 500 | 500 | 1.5s+ |

## Proposed Solutions

### Solution 1: LATERAL join (Recommended)

```sql
SELECT s.*,
       COALESCE(step_stats.step_count, 0) as step_count,
       COALESCE(enroll_stats.active, 0) as active_enrollments,
       COALESCE(enroll_stats.completed, 0) as completed_enrollments,
       COALESCE(enroll_stats.exited, 0) as exited_enrollments
FROM sequences s
LEFT JOIN LATERAL (
    SELECT COUNT(*) as step_count
    FROM sequence_steps WHERE sequence_id = s.id
) step_stats ON true
LEFT JOIN LATERAL (
    SELECT
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'completed') as completed,
        COUNT(*) FILTER (WHERE status IN ('exited', 'converted')) as exited
    FROM sequence_enrollments WHERE sequence_id = s.id
) enroll_stats ON true
WHERE s.organization_id = $1
```

**Pros:** Single query plan, optimizer can parallelize
**Cons:** Slightly more complex SQL
**Effort:** Small (30 min)
**Risk:** Low

### Solution 2: CTE with pre-aggregation

```sql
WITH step_counts AS (
    SELECT sequence_id, COUNT(*) as step_count
    FROM sequence_steps GROUP BY sequence_id
),
enrollment_stats AS (
    SELECT sequence_id,
           COUNT(*) FILTER (WHERE status = 'active') as active,
           ...
    FROM sequence_enrollments GROUP BY sequence_id
)
SELECT s.*, sc.step_count, es.active, ...
FROM sequences s
LEFT JOIN step_counts sc ON sc.sequence_id = s.id
LEFT JOIN enrollment_stats es ON es.sequence_id = s.id
WHERE s.organization_id = $1
```

**Pros:** Very clear structure
**Cons:** May scan entire tables if not filtered
**Effort:** Small (30 min)
**Risk:** Low

## Recommended Action

Implement Solution 1 (LATERAL join) as it matches the pattern used in `SequenceQueries.list()`.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - `_tool_get_sequences()` function

## Acceptance Criteria

- [ ] Query uses LATERAL join or CTE instead of correlated subquery
- [ ] EXPLAIN shows single query plan
- [ ] Query time <100ms for 100 sequences

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from performance review | O(n) subqueries pattern |

## Resources

- Performance assessment from performance-oracle agent

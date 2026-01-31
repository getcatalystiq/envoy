---
status: complete
priority: p2
issue_id: "017"
tags: [code-review, performance, database]
dependencies: []
---

# Missing Database Index for Dashboard/Analytics Queries

## Problem Statement

The `_tool_get_dashboard` and `_tool_get_analytics` functions perform time-range queries on `email_sends` table without an optimal composite index. As data grows, these queries will degrade significantly.

**Why it matters:** At 100K daily sends, 30-day dashboard queries will take 2-5 seconds instead of <100ms.

## Findings

### Current Query Pattern (lines 1040-1067):

```sql
SELECT DATE(created_at) as date, COUNT(*), ...
FROM email_sends
WHERE organization_id = $1
  AND created_at >= $2
  AND created_at <= $3
GROUP BY DATE(created_at)
ORDER BY date ASC
```

### Current Indexes on email_sends:
- `idx_email_sends_org_status` - includes status (not optimal for time-only queries)
- `idx_email_sends_campaign_status` - campaign-scoped
- `idx_email_sends_target` - target-scoped with created_at
- `idx_email_sends_outbox_id` - outbox lookup

### Missing Index:
```sql
CREATE INDEX idx_email_sends_org_created
    ON email_sends(organization_id, created_at);
```

### Scale Projections:

| Daily Sends | 30-day Rows | Current Latency | With Index |
|-------------|-------------|-----------------|------------|
| 1K | 30K | ~50ms | ~10ms |
| 10K | 300K | ~300ms | ~20ms |
| 100K | 3M | 2-5s | ~50ms |
| 1M | 30M | 10s+ | ~100ms |

## Proposed Solutions

### Solution 1: Add composite index (Recommended)

```sql
CREATE INDEX CONCURRENTLY idx_email_sends_org_created
    ON email_sends(organization_id, created_at);
```

**Pros:** Simple, immediate improvement
**Cons:** Additional storage, slightly slower inserts
**Effort:** Small (5 min to create)
**Risk:** Low - CONCURRENTLY doesn't lock table

### Solution 2: Pre-aggregated daily stats table

For very high volume, maintain a materialized view:

```sql
CREATE MATERIALIZED VIEW email_daily_stats AS
SELECT organization_id, DATE(created_at) as date,
       COUNT(*) as sends, ...
FROM email_sends
GROUP BY organization_id, DATE(created_at);
```

**Pros:** Sub-millisecond queries
**Cons:** Requires refresh mechanism
**Effort:** Large (4-8 hours)
**Risk:** Medium - adds operational complexity

### Solution 3: Add caching layer

Cache dashboard results for 60 seconds:

```python
@cached(ttl=60)
async def _get_cached_dashboard_data(org_id, days):
    ...
```

**Pros:** Reduces repeat queries
**Cons:** Slightly stale data
**Effort:** Medium (1-2 hours)
**Risk:** Low

## Recommended Action

Implement Solution 1 immediately. Consider Solution 3 as a follow-up.

## Technical Details

### Affected Files
- `migrations/031_add_email_sends_org_created_index.sql` (new)
- `functions/api/app/routers/mcp.py` - would benefit from index

### SQL Migration

```sql
-- migrations/031_add_email_sends_org_created_index.sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_sends_org_created
    ON email_sends(organization_id, created_at);
```

## Acceptance Criteria

- [ ] Index created on email_sends(organization_id, created_at)
- [ ] EXPLAIN ANALYZE shows index usage for dashboard query
- [ ] Query time <100ms for 100K row scan

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from performance review | Critical for scaling |

## Resources

- Performance assessment from performance-oracle agent

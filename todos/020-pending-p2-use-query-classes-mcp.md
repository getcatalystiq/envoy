---
status: pending
priority: p2
issue_id: "020"
tags: [code-review, architecture, mcp]
dependencies: []
---

# Use Query Classes Instead of Inline SQL in MCP Router

## Problem Statement

The MCP router uses inline SQL queries for several tools instead of leveraging existing Query classes. This duplicates logic, creates maintenance burden, and risks divergent behavior.

## Findings

### Inline SQL in MCP Router:

1. **`_tool_get_analytics`** (lines 971-1037) - Raw SQL for email_sends aggregation
2. **`_tool_get_dashboard`** (lines 1040-1093) - Raw SQL for daily stats
3. **`_tool_get_outbox`** (lines 1103-1192) - Raw SQL instead of `OutboxQueries`
4. **`_tool_approve_outbox_item`** (lines 1195-1248) - Raw SQL instead of `OutboxQueries.approve()`
5. **`_tool_reject_outbox_item`** (lines 1251-1294) - Raw SQL instead of `OutboxQueries.reject()`
6. **`_tool_get_sequences`** (lines 1297-1368) - Raw SQL instead of `SequenceQueries.list()`

### Existing Query Classes Available:

- `OutboxQueries` in `/layers/shared/shared/queries/outbox.py` - has `list()`, `approve()`, `reject()`
- `SequenceQueries` in `/layers/shared/shared/queries/sequences.py` - has `list()`, `get_with_stats()`

### Example Discrepancy:

MCP `_tool_approve_outbox_item`:
```python
await db.execute(
    "UPDATE outbox SET status = 'approved', updated_at = NOW() WHERE id = $1",
    UUID(outbox_id),
)
```

`OutboxQueries.approve()`:
```python
await conn.fetchrow(
    """
    UPDATE outbox
    SET status = 'approved', reviewed_by = $2, reviewed_at = NOW()
    WHERE id = $1 AND status = 'pending'
    RETURNING *
    """,
    outbox_id, reviewed_by,
)
```

**Differences:** MCP version missing `reviewed_by`, `reviewed_at`, and atomic status check.

## Proposed Solutions

### Solution 1: Refactor to use Query classes (Recommended)

Replace inline SQL with Query class methods:

```python
async def _tool_get_outbox(args, org_id, db):
    items = await OutboxQueries.list(db, org_id=org_id, status=status, limit=limit)
    # Transform to MCP response format
    ...
```

**Pros:** DRY, consistent behavior, maintained in one place
**Cons:** May need to adapt response format
**Effort:** Medium (2-3 hours)
**Risk:** Low

### Solution 2: Create AnalyticsQueries class

For analytics queries with no existing class:

```python
# layers/shared/shared/queries/analytics.py
class AnalyticsQueries:
    @staticmethod
    async def get_daily_stats(conn, org_id, start_date, end_date):
        ...

    @staticmethod
    async def get_summary(conn, org_id, days):
        ...
```

**Pros:** Proper separation of concerns
**Cons:** New file, additional abstraction
**Effort:** Medium (1-2 hours)
**Risk:** Low

## Recommended Action

Refactor outbox tools to use `OutboxQueries`, sequence tools to use `SequenceQueries`, and create `AnalyticsQueries` for analytics.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - all inline SQL tools
- `layers/shared/shared/queries/analytics.py` (new)

### Mapping

| MCP Tool | Should Use |
|----------|------------|
| `_tool_get_outbox` | `OutboxQueries.list()` |
| `_tool_approve_outbox_item` | `OutboxQueries.approve()` |
| `_tool_reject_outbox_item` | `OutboxQueries.reject()` |
| `_tool_get_sequences` | `SequenceQueries.list()` |
| `_tool_get_analytics` | `AnalyticsQueries.get_summary()` (new) |
| `_tool_get_dashboard` | `AnalyticsQueries.get_daily_stats()` (new) |

## Acceptance Criteria

- [ ] No inline SQL in MCP router for outbox operations
- [ ] No inline SQL in MCP router for sequence listing
- [ ] New AnalyticsQueries class for analytics operations
- [ ] All existing functionality preserved

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from architecture review | DRY violation, behavior divergence |

## Resources

- Architecture assessment from architecture-strategist agent
- `OutboxQueries` in `/layers/shared/shared/queries/outbox.py`
- `SequenceQueries` in `/layers/shared/shared/queries/sequences.py`

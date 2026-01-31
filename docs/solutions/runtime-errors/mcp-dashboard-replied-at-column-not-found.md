---
title: MCP Dashboard Tool Failing - Column replied_at Does Not Exist
category: runtime-errors
module: mcp
tags: [mcp, database, postgresql, schema-mismatch]
symptoms:
  - Dashboard widget shows "Loading..." forever
  - Console shows tool-input-partial but never tool-result
  - CloudWatch logs show "column replied_at does not exist"
severity: high
date_documented: 2026-01-31
---

# MCP Dashboard Tool Failing - Column replied_at Does Not Exist

## Problem Symptom

The MCP dashboard widget fails to load data. In the browser console:
- Widget connects successfully (`[Dashboard] Connected`)
- Multiple `tool-input-partial` messages appear (streaming)
- `tool-input` message appears (tool call ready)
- But `tool-result` never arrives

Claude.ai reports: "The dashboard endpoint is consistently failing."

## Investigation Steps

1. **Console logs showed no obvious client-side errors** - Widget was connecting and receiving tool input, but no result came back.

2. **Added debug logging to widget** - Added `ontoolinput`, `ontoolinputpartial`, `ontoolresult` handlers to trace MCP message flow.

3. **Checked CloudWatch logs** - Initially showed no errors (requests completing in 80-100ms).

4. **Added server-side logging** - Added try/catch with logging to `_tool_get_dashboard`:
   ```python
   logger.info(f"[Dashboard] Called with org_id={org_id}, args={args}")
   # ... function body ...
   logger.info(f"[Dashboard] Returning {len(daily_stats)} days, totals={totals}")
   ```

5. **CloudWatch revealed the error**:
   ```
   [ERROR] [Dashboard] Error: column "replied_at" does not exist
   ```

## Root Cause

The dashboard SQL query referenced a `replied_at` column that doesn't exist in the `email_sends` table:

```python
# BROKEN - replied_at column doesn't exist
rows = await db.fetch(
    """
    SELECT
        DATE(created_at) as date,
        COUNT(*) as sends,
        COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opens,
        COUNT(*) FILTER (WHERE status = 'clicked') as clicks,
        COUNT(*) FILTER (WHERE replied_at IS NOT NULL) as replies  -- WRONG!
    FROM email_sends
    ...
    """,
)
```

The `email_sends` table schema only has these status values: `queued`, `sent`, `delivered`, `opened`, `clicked`, `bounced`, `complained`, `failed`. There is no `replied` status or `replied_at` timestamp column.

## Solution

Replace `replied_at` reference with `delivered` metric using the existing `status` field:

```python
# FIXED - use status field that exists
rows = await db.fetch(
    """
    SELECT
        DATE(created_at) as date,
        COUNT(*) as sends,
        COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')) as delivered,
        COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opens,
        COUNT(*) FILTER (WHERE status = 'clicked') as clicks
    FROM email_sends
    ...
    """,
)

totals = {"sends": 0, "delivered": 0, "opens": 0, "clicks": 0}
```

Also updated the widget HTML/CSS to display "Delivered" instead of "Replies".

## Prevention Strategies

1. **Validate SQL queries against schema** - Before writing SQL that references columns, check the actual table schema in migrations.

2. **Add database integration tests** - Create tests that exercise MCP tool SQL queries against a test database to catch schema mismatches early.

3. **Use query classes** - Abstract SQL into dedicated query classes (like `EmailSendsQueries`) that are tested and validated, rather than inline SQL in tool handlers.

4. **Schema documentation** - Maintain up-to-date documentation of table schemas, especially for commonly queried tables like `email_sends`.

## Files Changed

- `functions/api/app/routers/mcp.py`:
  - Fixed `_tool_get_dashboard` SQL query
  - Updated `_get_dashboard_widget` HTML to show Delivered instead of Replies

## Related Issues

- The same pattern exists in other MCP tools with inline SQL - consider refactoring to use query classes (tracked in todo 020)

## Debugging Tips for MCP Widget Issues

When an MCP widget shows "Loading..." but never renders data:

1. **Check browser console** for `[host] Sending message tool-result` - if missing, the backend failed
2. **Add logging to the tool function** with try/catch to capture errors
3. **Check CloudWatch logs** for the specific Lambda function
4. **Verify SQL queries** reference existing columns by checking migrations

The MCP Apps SDK will silently fail to deliver tool results if the backend throws an exception, making these issues appear as client-side problems when they're actually server-side.

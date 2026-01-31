---
status: complete
priority: p1
issue_id: "016"
tags: [code-review, data-integrity, mcp]
dependencies: []
---

# Missing Transaction Boundaries in Outbox Approve Flow

## Problem Statement

The `_tool_approve_outbox_item` function performs two separate database operations (UPDATE outbox, INSERT email_sends) without a transaction wrapper. If the second operation fails, the outbox item shows as 'approved' but no email is queued.

**Why it matters:** Users will see emails as "approved" but they'll never be sent, causing silent data loss and broken customer communications.

## Findings

### Current Implementation (lines 1195-1248):

```python
# Operation 1: Update outbox status
await db.execute(
    "UPDATE outbox SET status = 'approved', updated_at = NOW() WHERE id = $1",
    UUID(outbox_id),
)

# GAP: No transaction - if crash/error here, orphaned 'approved' item

# Operation 2: Create email_sends record
await db.execute(
    """INSERT INTO email_sends ... WHERE o.id = $1""",
    UUID(outbox_id),
)
```

### Race Condition (same function):

```python
# Step 1: Check status (no lock)
item = await db.fetchrow("SELECT ... WHERE id = $1", outbox_id)

# GAP: Another request could approve here

# Step 2: Update (may double-approve)
await db.execute("UPDATE ... SET status = 'approved'", outbox_id)
```

**Result:** Two `email_sends` records can be created for the same outbox item, causing duplicate emails.

### Additional Issues:
- Missing `reviewed_by` and `reviewed_at` audit fields
- Missing `wrap_email_body()` call (inconsistent with main outbox router)

## Proposed Solutions

### Solution 1: Transaction with FOR UPDATE lock (Recommended)

```python
async with db.transaction():
    item = await db.fetchrow(
        "SELECT * FROM outbox WHERE id = $1 AND organization_id = $2 FOR UPDATE",
        UUID(outbox_id), org_id,
    )
    if not item or item["status"] != "pending":
        return error_response

    await db.execute(
        """UPDATE outbox SET status = 'approved', reviewed_at = NOW()
           WHERE id = $1""",
        UUID(outbox_id),
    )

    await db.execute(
        """INSERT INTO email_sends (...) SELECT ... WHERE o.id = $1""",
        UUID(outbox_id),
    )
```

**Pros:** Atomic operation, prevents race condition
**Cons:** Requires connection to support transactions
**Effort:** Small (30 min)
**Risk:** Low

### Solution 2: Atomic UPDATE with status check

```python
result = await db.execute(
    """UPDATE outbox SET status = 'approved'
       WHERE id = $1 AND status = 'pending'
       RETURNING id""",
    outbox_id
)
if not result:
    return error_response  # Already approved or rejected
```

**Pros:** Simpler, prevents double-approve
**Cons:** Still two operations without full atomicity
**Effort:** Small (15 min)
**Risk:** Low

### Solution 3: Use OutboxQueries class

Refactor to use existing `OutboxQueries.approve()` which has better patterns.

**Pros:** Consistent with rest of codebase
**Cons:** May need to adapt for MCP response format
**Effort:** Medium (1 hour)
**Risk:** Low

## Recommended Action

Implement Solution 1 for full atomicity, and also add the missing `reviewed_at` field.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - `_tool_approve_outbox_item()`, `_tool_reject_outbox_item()`

### Database Tables
- `outbox` - status update
- `email_sends` - record creation

## Acceptance Criteria

- [ ] Approve operation is wrapped in transaction
- [ ] FOR UPDATE lock prevents race conditions
- [ ] `reviewed_at` timestamp is set
- [ ] If INSERT fails, outbox status remains 'pending'
- [ ] Same fix applied to reject flow

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from data integrity review | Critical gap between approve and insert |

## Resources

- Data integrity assessment from data-integrity-guardian agent
- Compare with `OutboxQueries.approve()` in outbox.py

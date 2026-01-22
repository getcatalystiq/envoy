---
status: resolved
priority: p1
issue_id: "002"
tags: [code-review, security, authorization, idor]
dependencies: []
---

# Missing Authorization Check in delete_target Endpoint (IDOR)

## Problem Statement

The `delete_target` endpoint lacks organization verification, allowing authenticated users to delete targets from other organizations.

**Why it matters:** An attacker can delete targets belonging to other organizations, causing data loss and business disruption.

## Findings

**Source:** security-sentinel agent

**Location:** `/Users/marmarko/code/envoy/functions/api/app/routers/targets.py` lines 207-215

**Vulnerable Code:**
```python
@router.delete("/{target_id}", status_code=204)
async def delete_target(
    target_id: UUID,
    db: DBConnection,
) -> None:
    """Delete a target."""
    deleted = await TargetQueries.delete(db, target_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Target not found")
```

**Evidence:** No `CurrentOrg` dependency, no organization ownership check.

## Proposed Solutions

### Option A: Add org_id Check Before Delete (Recommended)
**Pros:** Simple, consistent with other endpoints
**Cons:** Requires fetching target first
**Effort:** Small (5 minutes)
**Risk:** Low

```python
@router.delete("/{target_id}", status_code=204)
async def delete_target(
    target_id: UUID,
    org_id: CurrentOrg,
    db: DBConnection,
) -> None:
    target = await TargetQueries.get_by_id(db, target_id)
    if not target or str(target.get("organization_id")) != org_id:
        raise HTTPException(status_code=404, detail="Target not found")
    await TargetQueries.delete(db, target_id)
```

### Option B: Modify TargetQueries.delete to Accept org_id
**Pros:** Single query (DELETE WHERE id AND org_id)
**Cons:** Changes query interface
**Effort:** Small
**Risk:** Low

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `functions/api/app/routers/targets.py`

## Acceptance Criteria

- [ ] `delete_target` endpoint includes `org_id: CurrentOrg` dependency
- [ ] Endpoint returns 404 for targets not belonging to user's organization
- [ ] Targets can only be deleted by users in the same organization

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Same pattern as get_target IDOR |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

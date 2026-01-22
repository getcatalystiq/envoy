---
status: resolved
priority: p1
issue_id: "001"
tags: [code-review, security, authorization, idor]
dependencies: []
---

# Missing Authorization Check in get_target Endpoint (IDOR)

## Problem Statement

The `get_target` endpoint does not verify that the target belongs to the requesting user's organization. This allows any authenticated user to access any target by ID across all organizations - a classic Insecure Direct Object Reference (IDOR) vulnerability.

**Why it matters:** An attacker with valid credentials for Organization A can enumerate and access target data (email, name, company, custom_fields, metadata) belonging to Organization B.

## Findings

**Source:** security-sentinel agent

**Location:** `/Users/marmarko/code/envoy/functions/api/app/routers/targets.py` lines 152-161

**Vulnerable Code:**
```python
@router.get("/{target_id}", response_model=TargetResponse)
async def get_target(
    target_id: UUID,
    db: DBConnection,
) -> TargetResponse:
    """Get a target by ID."""
    target = await TargetQueries.get_by_id(db, target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target not found")
    return TargetResponse(**target)
```

**Evidence:** The endpoint accepts `target_id` and fetches it without any organization check. The `CurrentOrg` dependency is not used.

## Proposed Solutions

### Option A: Add org_id Dependency and Verify Ownership (Recommended)
**Pros:** Simple fix, follows existing pattern in `update_target`
**Cons:** None
**Effort:** Small (5 minutes)
**Risk:** Low

```python
@router.get("/{target_id}", response_model=TargetResponse)
async def get_target(
    target_id: UUID,
    org_id: CurrentOrg,  # Add this
    db: DBConnection,
) -> TargetResponse:
    target = await TargetQueries.get_by_id(db, target_id)
    if not target or str(target.get("organization_id")) != org_id:
        raise HTTPException(status_code=404, detail="Target not found")
    return TargetResponse(**target)
```

### Option B: Modify TargetQueries.get_by_id to Accept org_id
**Pros:** Moves authorization to data layer
**Cons:** Requires changing query signature
**Effort:** Medium
**Risk:** Low

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `functions/api/app/routers/targets.py`

**Components:** targets router

**Database Changes:** None required

## Acceptance Criteria

- [ ] `get_target` endpoint includes `org_id: CurrentOrg` dependency
- [ ] Endpoint returns 404 for targets not belonging to user's organization
- [ ] No change in behavior for valid requests within same organization

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | IDOR vulnerability identified by security-sentinel |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6
- OWASP IDOR: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/05-Authorization_Testing/04-Testing_for_Insecure_Direct_Object_References

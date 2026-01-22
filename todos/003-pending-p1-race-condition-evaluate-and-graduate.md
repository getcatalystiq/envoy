---
status: pending
priority: p1
issue_id: "003"
tags: [code-review, data-integrity, race-condition, concurrency]
dependencies: []
---

# Race Condition in evaluate_and_graduate Function

## Problem Statement

The `evaluate_and_graduate` function reads the target without acquiring a lock, evaluates conditions, then calls `graduate()` which acquires a lock. Between the unlocked read and the locked graduation, another request can modify the target, causing graduation based on stale data.

**Why it matters:** Targets may be graduated incorrectly when concurrent updates occur, violating business rules.

## Findings

**Source:** data-integrity-guardian agent, performance-oracle agent

**Location:** `/Users/marmarko/code/envoy/layers/shared/shared/graduation.py` lines 272-301

**Problematic Code:**
```python
async def evaluate_and_graduate(...):
    # NO LOCK HERE - target fetched without FOR UPDATE
    target = await TargetQueries.get_by_id(conn, target_id)

    rule = await find_matching_rule(conn, org_id, target)

    if not rule:
        return None

    # Then calls graduate() which DOES lock
    return await graduate(...)
```

**Data Corruption Scenario:**
1. Thread A: reads target (lifecycle_stage=4), no lock
2. Thread B: updates target's lifecycle_stage to 2
3. Thread A: evaluates conditions against stale data (stage=4), matches rule
4. Thread A: calls `graduate()`, acquires lock, graduates based on outdated state

## Proposed Solutions

### Option A: Wrap Evaluation in Transaction with Lock (Recommended)
**Pros:** Atomic evaluation + graduation, prevents race condition
**Cons:** Longer lock hold time
**Effort:** Medium
**Risk:** Low

```python
async def evaluate_and_graduate(...):
    async with conn.transaction():
        target = await conn.fetchrow(
            "SELECT * FROM targets WHERE id = $1 FOR UPDATE",
            target_id,
        )
        if not target:
            raise TargetNotFoundError(...)

        rule = await find_matching_rule(conn, org_id, dict(target))
        if not rule:
            return None

        # Graduate within same transaction, target already locked
        return await _graduate_locked(conn, org_id, target, rule)
```

### Option B: Re-verify Conditions Inside graduate()
**Pros:** Simpler change
**Cons:** Conditions checked twice, still has brief window
**Effort:** Small
**Risk:** Medium

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `layers/shared/shared/graduation.py`

## Acceptance Criteria

- [ ] Condition evaluation and graduation are atomic
- [ ] No graduation occurs if target state changes between check and execution
- [ ] Concurrent update tests pass

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Classic TOCTOU race condition |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

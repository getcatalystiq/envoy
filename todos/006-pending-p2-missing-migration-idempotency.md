---
status: pending
priority: p2
issue_id: "006"
tags: [code-review, database, migration, deployment]
dependencies: []
---

# Missing Migration Idempotency Check

## Problem Statement

The migration `029_graduation_rules.sql` does not check if it has already been applied. If the migration runner fails partway through and retries, it will fail on duplicate table creation.

**Why it matters:** Deployment failures during migration retry, blocking production deploys.

## Findings

**Source:** data-migration-expert agent

**Location:** `/Users/marmarko/code/envoy/migrations/029_graduation_rules.sql`

**Missing Pattern:** Other migrations (001, 003, 013) include idempotency checks, this one doesn't.

## Proposed Solutions

### Option A: Add Standard Idempotency Check (Recommended)
**Pros:** Follows existing pattern, safe retries
**Cons:** None
**Effort:** Small
**Risk:** Low

Add after `BEGIN;`:
```sql
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM schema_migrations WHERE version = '029') THEN
        RAISE EXCEPTION 'Migration 029 already applied';
    END IF;
END $$;
```

Add before `COMMIT;`:
```sql
INSERT INTO schema_migrations (version, description)
VALUES ('029', 'Graduation rules and events tables');
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected Files:**
- `migrations/029_graduation_rules.sql`

## Acceptance Criteria

- [ ] Migration includes idempotency check
- [ ] Migration records itself in schema_migrations
- [ ] Running migration twice doesn't fail

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-21 | Created from code review | Standard migration pattern |

## Resources

- PR: https://github.com/getcatalystiq/envoy/pull/6

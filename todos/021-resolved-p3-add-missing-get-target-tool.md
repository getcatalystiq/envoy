---
status: complete
priority: p3
issue_id: "021"
tags: [code-review, agent-native, mcp]
dependencies: []
---

# Add Missing get_target Tool

## Problem Statement

The target list widget calls `app.callServerTool({ name: 'get_target', arguments: { target_id: id } })` but no `get_target` tool is defined in the TOOLS array. This causes widget click actions to fail.

## Findings

### Widget Code (line 1553):

```javascript
root.querySelectorAll('.target').forEach(el => {
    el.addEventListener('click', async () => {
        await app.callServerTool({ name: 'get_target', arguments: { target_id: id } });
    });
});
```

### TOOLS Array:

No `get_target` tool defined. Available target tools:
- `search_targets` - list/search
- `create_target` - create new

Missing:
- `get_target` - get single by ID
- `update_target` - update fields
- `delete_target` - remove

## Proposed Solutions

### Solution 1: Add get_target tool (Recommended)

```python
{
    "name": "get_target",
    "description": "Get detailed information about a specific target/lead by ID.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "target_id": {
                "type": "string",
                "format": "uuid",
                "description": "The target ID",
            },
        },
        "required": ["target_id"],
    },
    "annotations": {
        "title": "Get Lead Details",
        "readOnlyHint": True,
        "destructiveHint": False,
    },
}
```

Implementation:
```python
async def _tool_get_target(args, org_id, db):
    target = await TargetQueries.get_by_id(db, UUID(args["target_id"]))
    if not target or str(target.get("organization_id")) != org_id:
        return {"content": [...], "isError": True}
    return {
        "content": [...],
        "structuredContent": {"target": {...}},
    }
```

**Pros:** Enables widget functionality, common use case
**Cons:** Small scope increase
**Effort:** Small (30 min)
**Risk:** Low

### Solution 2: Remove widget click handler

Update widget to not call get_target if it's not needed.

**Pros:** Simpler
**Cons:** Loses functionality
**Effort:** Small
**Risk:** Low

## Recommended Action

Implement Solution 1 - add the tool. Also consider adding `update_target` and `delete_target` for full CRUD parity.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - add tool definition and handler

## Acceptance Criteria

- [ ] `get_target` tool defined in TOOLS array
- [ ] Tool handler implemented with org_id check
- [ ] Widget click action works correctly
- [ ] Tool returns full target details (all fields)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from agent-native review | Widget references missing tool |

## Resources

- Agent-native assessment from agent-native-reviewer agent

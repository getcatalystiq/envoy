---
status: complete
priority: p2
issue_id: "019"
tags: [code-review, simplification, mcp]
dependencies: []
---

# Simplify _handle_read_resource with Widget Mapping

## Problem Statement

The `_handle_read_resource` function has 5 nearly identical if/elif blocks (~80 lines) that only differ in URI and widget function. This violates DRY and makes adding new widgets error-prone.

## Findings

### Current Pattern (lines 595-682):

```python
if uri == "ui://widget/target-list.html":
    return {
        "contents": [{
            "uri": uri,
            "mimeType": MCP_APP_MIME_TYPE,
            "text": _get_target_list_widget(),
            "_meta": {"ui": {"csp": csp_config}},
        }]
    }
elif uri == "ui://widget/analytics-summary.html":
    return {
        "contents": [{
            "uri": uri,
            "mimeType": MCP_APP_MIME_TYPE,
            "text": _get_analytics_widget(),
            # ... same structure
        }]
    }
# ... 3 more identical blocks
```

## Proposed Solutions

### Solution 1: Widget function mapping (Recommended)

```python
WIDGET_FUNCTIONS = {
    "ui://widget/target-list.html": _get_target_list_widget,
    "ui://widget/analytics-summary.html": _get_analytics_widget,
    "ui://widget/dashboard.html": _get_dashboard_widget,
    "ui://widget/outbox.html": _get_outbox_widget,
    "ui://widget/sequences.html": _get_sequences_widget,
}

async def _handle_read_resource(params: dict[str, Any]) -> dict[str, Any]:
    uri = params.get("uri", "")
    csp_config = {
        "resourceDomains": ["https://cdn.jsdelivr.net"],
        "connectDomains": ["https://cdn.jsdelivr.net"],
    }

    widget_fn = WIDGET_FUNCTIONS.get(uri)
    if not widget_fn:
        raise ValueError(f"Unknown resource: {uri}")

    return {
        "contents": [{
            "uri": uri,
            "mimeType": MCP_APP_MIME_TYPE,
            "text": widget_fn(),
            "_meta": {"ui": {"csp": csp_config}},
        }]
    }
```

**Pros:** 80 lines → 15 lines, adding widgets is one line
**Cons:** None
**Effort:** Small (15 min)
**Risk:** Very low

### Solution 2: Generate WIDGET_RESOURCES from WIDGET_FUNCTIONS

Also derive the `WIDGET_RESOURCES` list from the mapping to ensure consistency:

```python
WIDGET_RESOURCES = [
    {
        "uri": uri,
        "name": fn.__doc__.split('\n')[0] if fn.__doc__ else uri.split('/')[-1],
        "mimeType": MCP_APP_MIME_TYPE,
        "description": fn.__doc__ or "",
    }
    for uri, fn in WIDGET_FUNCTIONS.items()
]
```

**Pros:** Single source of truth
**Cons:** Requires docstrings on widget functions
**Effort:** Small (30 min)
**Risk:** Low

## Recommended Action

Implement Solution 1. Consider Solution 2 as a follow-up.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - `_handle_read_resource()` function

## Acceptance Criteria

- [ ] Single mapping dict for widget URIs to functions
- [ ] One return statement for all widgets
- [ ] All existing widget URIs still work
- [ ] Error case still raises ValueError for unknown URIs

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from simplicity review | Easy win, high impact |

## Resources

- Simplicity assessment from code-simplicity-reviewer agent

---
status: complete
priority: p3
issue_id: "022"
tags: [code-review, security, cleanup]
dependencies: []
---

# Remove Debug Print Statements from MCP Router

## Problem Statement

The MCP router contains debug `print()` statements that expose request parameters in logs. This is not suitable for production and may expose sensitive data.

## Findings

### Debug Statement (line 518):

```python
@router.post("")
@router.post("/")
async def mcp_handler(...) -> MCPResponse:
    print(f"[MCP] method={mcp_request.method} params={mcp_request.params}")
```

**Issues:**
- `print()` not suitable for production logging
- `params` may contain sensitive arguments
- No log level control

## Proposed Solutions

### Solution 1: Remove print statement (Recommended for now)

Simply remove the debug print:

```python
async def mcp_handler(...) -> MCPResponse:
    # Debug print removed
    try:
        result = await _dispatch_method(...)
```

**Pros:** Immediate fix
**Cons:** Loses debug visibility
**Effort:** Trivial
**Risk:** None

### Solution 2: Replace with proper logging

```python
import logging
logger = logging.getLogger(__name__)

async def mcp_handler(...) -> MCPResponse:
    logger.debug("MCP request: method=%s", mcp_request.method)
    # Don't log params as they may contain sensitive data
```

**Pros:** Proper log infrastructure
**Cons:** Slight additional work
**Effort:** Small
**Risk:** None

## Recommended Action

Implement Solution 1 (remove) or Solution 2 (proper logging) depending on whether debug visibility is needed.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` - line 518

## Acceptance Criteria

- [ ] No `print()` statements in production code
- [ ] If logging needed, use proper logger with DEBUG level
- [ ] Sensitive params not logged

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from security review | Debug code in production |

## Resources

- Security assessment from security-sentinel agent

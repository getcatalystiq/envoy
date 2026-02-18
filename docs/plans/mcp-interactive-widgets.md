# MCP Interactive Widgets Plan

## Overview

Add 4 new MCP interactive widgets to enhance the Claude.ai integration:

1. **Dashboard Graphs Widget** - Interactive time-series charts for analytics
2. **Outbox Widget** - Full-featured outbox with email details and actions
3. **Enhanced Target Search Widget** - Add search box and show all data fields
4. **Sequences Widget** - Mirror the /sequences page

## Existing Patterns

Based on the current implementation in `functions/api/app/routers/mcp.py`:

- Widgets use `@modelcontextprotocol/ext-apps` SDK from jsdelivr CDN
- Tool definitions include `_meta.ui.resourceUri` for widget association
- Widget HTML is served via `resources/read` with `text/html;profile=mcp-app` MIME type
- CSP config: `resourceDomains` and `connectDomains` for jsdelivr
- Data passed via `structuredContent` in tool responses
- Theme handling via `app.onhostcontextchanged` with CSS variables

## Widget 1: Dashboard Graphs

### Tool Definition

```python
{
    "name": "get_dashboard",
    "description": "Get dashboard with interactive analytics charts showing sends, opens, clicks, and replies over time",
    "inputSchema": {
        "type": "object",
        "properties": {
            "days": {
                "type": "integer",
                "description": "Number of days to show (default: 30)",
                "default": 30
            }
        }
    },
    "annotations": {
        "title": "Dashboard",
        "readOnlyHint": True,
        "destructiveHint": False,
    },
    "_meta": {
        "ui": {
            "resourceUri": "ui://widget/dashboard.html"
        }
    },
}
```

### Data Structure

Reuse existing `/api/v1/analytics/dashboard` endpoint data:

```python
{
    "daily_stats": [
        {"date": "2025-01-01", "sends": 10, "opens": 5, "clicks": 2, "replies": 1},
        ...
    ],
    "totals": {
        "sends": 150,
        "opens": 75,
        "clicks": 30,
        "replies": 15
    }
}
```

### Widget Implementation

- Use Chart.js or lightweight SVG-based charts
- Line chart with 4 series (sends, opens, clicks, replies)
- Summary cards showing totals at top
- Responsive design for widget container
- Theme-aware colors via CSS variables

## Widget 2: Outbox

### Tool Definition

```python
{
    "name": "get_outbox",
    "description": "Get pending outbox items awaiting approval with full email details",
    "inputSchema": {
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["pending", "approved", "rejected", "all"],
                "default": "pending"
            },
            "limit": {
                "type": "integer",
                "default": 20
            }
        }
    },
    "annotations": {
        "title": "Outbox",
        "readOnlyHint": False,
        "destructiveHint": False,
    },
    "_meta": {
        "ui": {
            "resourceUri": "ui://widget/outbox.html"
        }
    },
}
```

### Action Tools

```python
{
    "name": "approve_outbox_item",
    "description": "Approve an outbox item for sending",
    "inputSchema": {
        "type": "object",
        "properties": {
            "outbox_id": {"type": "string", "description": "Outbox item ID"}
        },
        "required": ["outbox_id"]
    }
}

{
    "name": "reject_outbox_item",
    "description": "Reject an outbox item",
    "inputSchema": {
        "type": "object",
        "properties": {
            "outbox_id": {"type": "string", "description": "Outbox item ID"},
            "reason": {"type": "string", "description": "Rejection reason"}
        },
        "required": ["outbox_id"]
    }
}
```

### Data Structure

```python
{
    "items": [
        {
            "id": "uuid",
            "target": {
                "email": "john@example.com",
                "first_name": "John",
                "last_name": "Doe",
                "company": "Acme Inc"
            },
            "subject": "Email subject",
            "body": "Email HTML body",
            "status": "pending",
            "created_at": "2025-01-30T10:00:00Z",
            "scheduled_for": "2025-01-30T14:00:00Z"
        }
    ],
    "total": 45,
    "pending_count": 12
}
```

### Widget Implementation

- List view with expandable email preview
- Action buttons: Approve, Reject
- Status badges (pending/approved/rejected)
- Email body rendered in iframe for safety
- Bulk actions support (approve all visible)

## Widget 3: Enhanced Target Search

### Tool Update

Update existing `search_targets` tool:

```python
{
    "name": "search_targets",
    "description": "Search for targets/leads with optional filters. Returns name, email, company, phone, type, and status.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Search query for name, email, or company"
            },
            "type": {
                "type": "string",
                "description": "Filter by target type"
            },
            "status": {
                "type": "string",
                "enum": ["active", "converted", "unsubscribed", "bounced"]
            },
            "limit": {
                "type": "integer",
                "default": 20
            }
        }
    },
    ...
}
```

### Data Structure Update

```python
{
    "targets": [
        {
            "id": "uuid",
            "email": "john@example.com",
            "first_name": "John",
            "last_name": "Doe",
            "company": "Acme Inc",
            "phone": "+1-555-0123",
            "type": "lead",
            "status": "active",
            "created_at": "2025-01-15T10:00:00Z"
        }
    ],
    "total": 150,
    "query": "john"
}
```

### Widget Implementation

- Search input box at top (debounced, 300ms)
- Table with columns: Name, Email, Company, Phone, Type, Status
- Sortable columns
- Status badges with colors
- Click to view target details
- Type filter dropdown

## Widget 4: Sequences

### Tool Definition

```python
{
    "name": "get_sequences",
    "description": "Get all sequences with enrollment counts and status",
    "inputSchema": {
        "type": "object",
        "properties": {
            "status": {
                "type": "string",
                "enum": ["active", "paused", "draft", "all"],
                "default": "all"
            }
        }
    },
    "annotations": {
        "title": "Sequences",
        "readOnlyHint": True,
        "destructiveHint": False,
    },
    "_meta": {
        "ui": {
            "resourceUri": "ui://widget/sequences.html"
        }
    },
}
```

### Data Structure

```python
{
    "sequences": [
        {
            "id": "uuid",
            "name": "Welcome Sequence",
            "description": "Onboarding emails for new leads",
            "status": "active",
            "step_count": 5,
            "enrollments": {
                "active": 45,
                "completed": 120,
                "exited": 8
            },
            "created_at": "2025-01-01T10:00:00Z"
        }
    ],
    "total": 8
}
```

### Widget Implementation

- Card grid or list view
- Status badge (active/paused/draft)
- Step count indicator
- Enrollment stats (active/completed/exited)
- Visual progress indicator for active enrollments

## Implementation Order

1. **Enhanced Target Search** - Simplest, just extends existing widget
2. **Dashboard Graphs** - Read-only, uses existing endpoint
3. **Sequences** - Read-only, new endpoint needed
4. **Outbox** - Most complex, requires action tools

## File Changes

### `functions/api/app/routers/mcp.py`

1. Add new tool definitions to `TOOLS` list
2. Add tool handlers in `_tool_*` functions
3. Add widget HTML in `_WIDGET_*` constants
4. Register widgets in `resources/list` and `resources/read`

### `layers/shared/shared/queries/`

1. `outbox.py` - Add `get_pending_with_details()` method
2. `sequences.py` - Add `get_all_with_stats()` method (or use existing)

## Shared Widget Components

Extract common patterns into reusable JavaScript:

```javascript
// Theme handling
function applyTheme(hostContext) {
    const theme = hostContext?.appearance?.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
}

// Loading state
function showLoading(container) {
    container.innerHTML = '<div class="loading">Loading...</div>';
}

// Error state
function showError(container, message) {
    container.innerHTML = `<div class="error">${message}</div>`;
}
```

## CSS Variables for Theming

```css
:root {
    --bg-primary: #ffffff;
    --bg-secondary: #f5f5f5;
    --text-primary: #1a1a1a;
    --text-secondary: #666666;
    --border-color: #e0e0e0;
    --accent-color: #0066cc;
}

[data-theme="dark"] {
    --bg-primary: #1a1a1a;
    --bg-secondary: #2a2a2a;
    --text-primary: #ffffff;
    --text-secondary: #aaaaaa;
    --border-color: #404040;
    --accent-color: #4da6ff;
}
```

## Testing

Each widget should be tested with:

1. **basic-host** from MCP ext-apps examples
2. Claude.ai production integration
3. Light and dark theme
4. Empty state (no data)
5. Error state (API failure)
6. Large dataset (pagination)

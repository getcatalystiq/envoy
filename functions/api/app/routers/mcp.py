"""MCP (Model Context Protocol) router for ChatGPT and other MCP clients."""

import json
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.dependencies import CurrentOrg, DBConnection, MavenDep, TokenClaims
from shared.queries import CampaignQueries, SequenceQueries, TargetQueries, ContentQueries

router = APIRouter()


# --------------------------------------------------------------------------
# MCP Protocol Types
# --------------------------------------------------------------------------

class MCPRequest(BaseModel):
    """MCP JSON-RPC request."""

    jsonrpc: str = "2.0"
    id: int | str | None = None
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class MCPError(BaseModel):
    """MCP error response."""

    code: int
    message: str
    data: dict[str, Any] | None = None


class MCPResponse(BaseModel):
    """MCP JSON-RPC response."""

    jsonrpc: str = "2.0"
    id: int | str | None = None
    result: dict[str, Any] | None = None
    error: MCPError | None = None


# --------------------------------------------------------------------------
# Tool Definitions
# --------------------------------------------------------------------------

LIFECYCLE_STAGES = {
    0: "Unaware",
    1: "Aware",
    2: "Interested",
    3: "Considering",
    4: "Intent",
    5: "Converted",
    6: "Advocate",
}

TOOLS = [
    {
        "name": "search_targets",
        "description": "Search for leads/targets in your Envoy database. "
                      "Filter by lifecycle stage, status, or full-text search on name/email.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query for name or email",
                },
                "lifecycle_stage": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 6,
                    "description": "0=Unaware, 1=Aware, 2=Interested, 3=Considering, 4=Intent, 5=Converted, 6=Advocate",
                },
                "status": {
                    "type": "string",
                    "enum": ["active", "unsubscribed", "bounced"],
                },
                "limit": {
                    "type": "integer",
                    "default": 20,
                    "maximum": 100,
                },
            },
        },
        "annotations": {
            "title": "Search Leads",
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": False,
        },
        "_meta": {
            "ui": {
                "resourceUri": "ui://widget/target-list.html"
            }
        },
    },
    {
        "name": "create_target",
        "description": "Create a new lead/target in your Envoy database. "
                      "Use this when someone mentions a new contact to add.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "email": {
                    "type": "string",
                    "format": "email",
                    "description": "Email address (required)",
                },
                "first_name": {
                    "type": "string",
                    "description": "First name",
                },
                "last_name": {
                    "type": "string",
                    "description": "Last name",
                },
                "company": {
                    "type": "string",
                    "description": "Company name",
                },
                "lifecycle_stage": {
                    "type": "integer",
                    "default": 0,
                    "minimum": 0,
                    "maximum": 6,
                },
            },
            "required": ["email"],
        },
        "annotations": {
            "title": "Create Lead",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": False,
        },
    },
    {
        "name": "generate_email_content",
        "description": "Generate personalized AI email content for a specific lead. "
                      "Uses Maven AI to create contextual, engaging emails.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "target_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "The target/lead ID to generate content for",
                },
                "content_type": {
                    "type": "string",
                    "enum": ["educational", "case_study", "promotional"],
                    "default": "educational",
                    "description": "Type of email content to generate",
                },
            },
            "required": ["target_id"],
        },
        "annotations": {
            "title": "Generate Email",
            "readOnlyHint": False,
            "destructiveHint": False,
            "openWorldHint": True,  # Calls external Maven AI
        },
    },
    {
        "name": "list_campaigns",
        "description": "List all email campaigns with their status and stats.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["draft", "scheduled", "active", "paused", "completed"],
                },
                "limit": {
                    "type": "integer",
                    "default": 20,
                    "maximum": 100,
                },
            },
        },
        "annotations": {
            "title": "List Campaigns",
            "readOnlyHint": True,
            "destructiveHint": False,
        },
    },
    {
        "name": "start_campaign",
        "description": "Start an email campaign. Only works for campaigns in draft, scheduled, or paused status.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "campaign_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "Campaign ID to start",
                },
            },
            "required": ["campaign_id"],
        },
        "annotations": {
            "title": "Start Campaign",
            "readOnlyHint": False,
            "destructiveHint": False,
            "openWorldHint": True,  # Sends real emails
            "idempotentHint": False,
        },
    },
    {
        "name": "get_analytics",
        "description": "Get email engagement analytics including open rates, click rates, and delivery stats.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "days": {
                    "type": "integer",
                    "default": 30,
                    "minimum": 1,
                    "maximum": 365,
                    "description": "Number of days to analyze",
                },
                "campaign_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "Filter by specific campaign",
                },
            },
        },
        "annotations": {
            "title": "Get Analytics",
            "readOnlyHint": True,
            "destructiveHint": False,
        },
        "_meta": {
            "ui": {
                "resourceUri": "ui://widget/analytics-summary.html"
            }
        },
    },
    {
        "name": "get_step_content",
        "description": "Get the content blocks for a sequence step, including personalization settings. "
                      "Returns the builder_content JSON with block IDs and their personalization config.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "step_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "The sequence step ID",
                },
            },
            "required": ["step_id"],
        },
        "annotations": {
            "title": "Get Step Content",
            "readOnlyHint": True,
            "destructiveHint": False,
        },
    },
    {
        "name": "set_block_personalization",
        "description": "Enable or disable AI personalization on a specific content block within a step. "
                      "When enabled, the block content will be personalized for each recipient during scheduling.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "step_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "The sequence step ID",
                },
                "block_id": {
                    "type": "string",
                    "description": "Block ID within builder_content",
                },
                "enabled": {
                    "type": "boolean",
                    "description": "Whether personalization is enabled for this block",
                },
                "prompt": {
                    "type": "string",
                    "maxLength": 1000,
                    "description": "Personalization instructions for Maven AI",
                },
            },
            "required": ["step_id", "block_id", "enabled"],
        },
        "annotations": {
            "title": "Set Block Personalization",
            "readOnlyHint": False,
            "destructiveHint": False,
            "idempotentHint": True,
        },
    },
    {
        "name": "preview_block_personalization",
        "description": "Preview what Maven AI would generate for a personalized block without scheduling. "
                      "Useful for testing personalization prompts before enabling them.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "step_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "The sequence step ID",
                },
                "block_id": {
                    "type": "string",
                    "description": "Block ID within builder_content",
                },
                "target_id": {
                    "type": "string",
                    "format": "uuid",
                    "description": "Target/lead ID to personalize for",
                },
            },
            "required": ["step_id", "block_id", "target_id"],
        },
        "annotations": {
            "title": "Preview Block Personalization",
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": True,
        },
    },
]

# MCP Apps SDK resource MIME type
MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

# Widget resources for MCP Apps SDK
WIDGET_RESOURCES = [
    {
        "uri": "ui://widget/target-list.html",
        "name": "Target List Widget",
        "mimeType": MCP_APP_MIME_TYPE,
        "description": "Interactive list of leads with lifecycle stages",
    },
    {
        "uri": "ui://widget/analytics-summary.html",
        "name": "Analytics Summary Widget",
        "mimeType": MCP_APP_MIME_TYPE,
        "description": "Visual summary of email engagement metrics",
    },
]


# --------------------------------------------------------------------------
# MCP Protocol Handler
# --------------------------------------------------------------------------

@router.post("")
@router.post("/")
async def mcp_handler(
    request: Request,
    mcp_request: MCPRequest,
    org_id: CurrentOrg,
    db: DBConnection,
    maven: MavenDep,
    claims: TokenClaims,
) -> MCPResponse:
    """Handle MCP JSON-RPC requests."""
    print(f"[MCP] method={mcp_request.method} params={mcp_request.params}")
    try:
        result = await _dispatch_method(
            method=mcp_request.method,
            params=mcp_request.params,
            org_id=org_id,
            db=db,
            maven=maven,
            claims=claims,
        )
        return MCPResponse(id=mcp_request.id, result=result)
    except HTTPException as e:
        return MCPResponse(
            id=mcp_request.id,
            error=MCPError(code=-32000, message=e.detail),
        )
    except ValueError as e:
        return MCPResponse(
            id=mcp_request.id,
            error=MCPError(code=-32602, message=str(e)),
        )
    except Exception as e:
        return MCPResponse(
            id=mcp_request.id,
            error=MCPError(code=-32603, message=f"Internal error: {e}"),
        )


async def _dispatch_method(
    method: str,
    params: dict[str, Any],
    org_id: str,
    db: Any,
    maven: Any,
    claims: dict[str, Any],
) -> dict[str, Any]:
    """Dispatch MCP method to handler."""
    match method:
        case "initialize":
            return _handle_initialize()
        case "tools/list":
            return _handle_list_tools()
        case "tools/call":
            return await _handle_call_tool(params, org_id, db, maven)
        case "resources/list":
            return _handle_list_resources()
        case "resources/read":
            return await _handle_read_resource(params)
        case _:
            raise ValueError(f"Unknown method: {method}")


def _handle_initialize() -> dict[str, Any]:
    """Handle MCP initialize request."""
    return {
        "protocolVersion": "2025-06-18",
        "capabilities": {
            "tools": {},
            "resources": {},
        },
        "serverInfo": {
            "name": "envoy-mcp",
            "version": "1.0.0",
        },
    }


def _handle_list_tools() -> dict[str, Any]:
    """Handle tools/list request."""
    return {"tools": TOOLS}


def _handle_list_resources() -> dict[str, Any]:
    """Handle resources/list request."""
    return {"resources": WIDGET_RESOURCES}


async def _handle_read_resource(params: dict[str, Any]) -> dict[str, Any]:
    """Handle resources/read request - serve widget HTML."""
    uri = params.get("uri", "")

    # CSP config for widgets that load MCP Apps SDK from esm.sh
    csp_config = {
        "resourceDomains": ["https://esm.sh"],
        "connectDomains": ["https://esm.sh"],
    }

    if uri == "ui://widget/target-list.html":
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": MCP_APP_MIME_TYPE,
                    "text": _get_target_list_widget(),
                    "_meta": {
                        "ui": {
                            "csp": csp_config,
                        },
                    },
                }
            ]
        }
    elif uri == "ui://widget/analytics-summary.html":
        return {
            "contents": [
                {
                    "uri": uri,
                    "mimeType": MCP_APP_MIME_TYPE,
                    "text": _get_analytics_widget(),
                    "_meta": {
                        "ui": {
                            "csp": csp_config,
                        },
                    },
                }
            ]
        }
    else:
        raise ValueError(f"Unknown resource: {uri}")


async def _handle_call_tool(
    params: dict[str, Any],
    org_id: str,
    db: Any,
    maven: Any,
) -> dict[str, Any]:
    """Handle tools/call request."""
    tool_name = params.get("name")
    args = params.get("arguments", {})

    match tool_name:
        case "search_targets":
            return await _tool_search_targets(args, org_id, db)
        case "create_target":
            return await _tool_create_target(args, org_id, db)
        case "generate_email_content":
            return await _tool_generate_email_content(args, org_id, db, maven)
        case "list_campaigns":
            return await _tool_list_campaigns(args, org_id, db)
        case "start_campaign":
            return await _tool_start_campaign(args, org_id, db)
        case "get_analytics":
            return await _tool_get_analytics(args, org_id, db)
        case "get_step_content":
            return await _tool_get_step_content(args, org_id, db)
        case "set_block_personalization":
            return await _tool_set_block_personalization(args, org_id, db)
        case "preview_block_personalization":
            return await _tool_preview_block_personalization(args, org_id, db, maven)
        case _:
            raise ValueError(f"Unknown tool: {tool_name}")


# --------------------------------------------------------------------------
# Tool Implementations
# --------------------------------------------------------------------------

async def _tool_search_targets(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Search targets tool implementation."""
    targets = await TargetQueries.list(
        db,
        org_id=org_id,
        status=args.get("status"),
        lifecycle_stage=args.get("lifecycle_stage"),
        limit=args.get("limit", 20),
        offset=0,
    )

    # Format for response
    formatted = []
    for t in targets:
        formatted.append({
            "id": str(t["id"]),
            "email": t["email"],
            "name": f"{t.get('first_name', '') or ''} {t.get('last_name', '') or ''}".strip() or None,
            "company": t.get("company"),
            "lifecycle_stage": t["lifecycle_stage"],
            "lifecycle_stage_name": LIFECYCLE_STAGES.get(t["lifecycle_stage"], "Unknown"),
            "status": t["status"],
        })

    return {
        "content": [
            {"type": "text", "text": f"Found {len(formatted)} leads matching your search."}
        ],
        "structuredContent": {
            "targets": formatted,
            "summary": {"total": len(formatted)},
        },
        "_meta": {
            "ui": {
                "resourceUri": "ui://widget/target-list.html",
                "visibility": ["app", "model"],
            },
        },
    }


async def _tool_create_target(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Create target tool implementation."""
    email = args.get("email")
    if not email:
        raise ValueError("email is required")

    # Check if exists
    existing = await TargetQueries.get_by_email(db, org_id, email)
    if existing:
        return {
            "content": [
                {"type": "text", "text": f"A lead with email {email} already exists."}
            ],
            "isError": True,
        }

    target = await TargetQueries.create(
        db,
        org_id=org_id,
        email=email,
        first_name=args.get("first_name"),
        last_name=args.get("last_name"),
        company=args.get("company"),
        lifecycle_stage=args.get("lifecycle_stage", 0),
    )

    name = f"{args.get('first_name', '')} {args.get('last_name', '')}".strip() or email

    return {
        "content": [
            {"type": "text", "text": f"Created new lead: {name} ({email})"}
        ],
        "structuredContent": {
            "target": {
                "id": str(target["id"]),
                "email": target["email"],
                "name": name,
                "lifecycle_stage": target["lifecycle_stage"],
            },
        },
    }


async def _tool_generate_email_content(
    args: dict[str, Any],
    org_id: str,
    db: Any,
    maven: Any,
) -> dict[str, Any]:
    """Generate email content tool implementation."""
    target_id = args.get("target_id")
    if not target_id:
        raise ValueError("target_id is required")

    target = await TargetQueries.get_by_id(db, UUID(target_id))
    if not target:
        return {
            "content": [{"type": "text", "text": "Target not found."}],
            "isError": True,
        }

    content_type = args.get("content_type", "educational")

    # Generate via Maven AI
    result = await maven.generate_content(
        target=target,
        content_type=content_type,
    )

    # Save generated content
    content = await ContentQueries.create(
        db,
        org_id=org_id,
        name=f"AI Generated - {target['email']} - {content_type}",
        content_type=content_type,
        channel="email",
        subject=result.get("subject"),
        body=result.get("body", result.get("raw", "")),
        lifecycle_stage=target.get("lifecycle_stage"),
        status="draft",
    )

    return {
        "content": [
            {"type": "text", "text": f"Generated {content_type} email for {target['email']}:\n\n**Subject:** {result.get('subject', 'N/A')}\n\n{result.get('body', '')}"}
        ],
        "structuredContent": {
            "content": {
                "id": str(content["id"]),
                "subject": result.get("subject"),
                "body": result.get("body"),
                "content_type": content_type,
            },
            "target": {
                "id": str(target["id"]),
                "email": target["email"],
            },
        },
    }


async def _tool_list_campaigns(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """List campaigns tool implementation."""
    campaigns = await CampaignQueries.list(
        db,
        org_id=org_id,
        status=args.get("status"),
        limit=args.get("limit", 20),
        offset=0,
    )

    formatted = []
    for c in campaigns:
        formatted.append({
            "id": str(c["id"]),
            "name": c["name"],
            "status": c["status"],
            "stats": c.get("stats", {}),
            "created_at": c["created_at"].isoformat() if c.get("created_at") else None,
        })

    # Group by status for summary
    by_status = {}
    for c in formatted:
        by_status[c["status"]] = by_status.get(c["status"], 0) + 1

    return {
        "content": [
            {"type": "text", "text": f"Found {len(formatted)} campaigns. " +
             ", ".join(f"{count} {status}" for status, count in by_status.items())}
        ],
        "structuredContent": {
            "campaigns": formatted,
            "summary": {"total": len(formatted), "by_status": by_status},
        },
    }


async def _tool_start_campaign(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Start campaign tool implementation."""
    campaign_id = args.get("campaign_id")
    if not campaign_id:
        raise ValueError("campaign_id is required")

    campaign = await CampaignQueries.get_by_id(db, UUID(campaign_id))
    if not campaign:
        return {
            "content": [{"type": "text", "text": "Campaign not found."}],
            "isError": True,
        }

    if campaign["status"] not in ("draft", "scheduled", "paused"):
        return {
            "content": [
                {"type": "text", "text": f"Cannot start campaign in '{campaign['status']}' status. "
                                         "Only draft, scheduled, or paused campaigns can be started."}
            ],
            "isError": True,
        }

    updated = await CampaignQueries.update_status(
        db,
        UUID(campaign_id),
        status="active",
        started_at="NOW()",
    )

    return {
        "content": [
            {"type": "text", "text": f"Campaign '{campaign['name']}' is now active and sending emails."}
        ],
        "structuredContent": {
            "campaign": {
                "id": str(updated["id"]),
                "name": updated["name"],
                "status": updated["status"],
            },
        },
    }


async def _tool_get_analytics(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Get analytics tool implementation."""
    days = args.get("days", 30)
    campaign_id = args.get("campaign_id")

    end_date = datetime.utcnow()
    start_date = end_date - timedelta(days=days)

    # Build query
    conditions = ["organization_id = $1", "created_at >= $2", "created_at <= $3"]
    params = [org_id, start_date, end_date]

    if campaign_id:
        conditions.append(f"campaign_id = ${len(params) + 1}")
        params.append(UUID(campaign_id))

    where_clause = " AND ".join(conditions)

    row = await db.fetchrow(
        f"""
        SELECT
            COUNT(*) as total_sent,
            COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked')) as delivered,
            COUNT(*) FILTER (WHERE status IN ('opened', 'clicked')) as opened,
            COUNT(*) FILTER (WHERE status = 'clicked') as clicked,
            COUNT(*) FILTER (WHERE status = 'bounced') as bounced
        FROM email_sends
        WHERE {where_clause}
        """,
        *params,
    )

    total = row["total_sent"] or 1
    delivered = row["delivered"] or 0
    opened = row["opened"] or 0
    clicked = row["clicked"] or 0
    bounced = row["bounced"] or 0

    metrics = {
        "total_sent": total,
        "delivered": delivered,
        "opened": opened,
        "clicked": clicked,
        "bounced": bounced,
        "delivery_rate": round(delivered / total * 100, 1) if total > 0 else 0,
        "open_rate": round(opened / delivered * 100, 1) if delivered > 0 else 0,
        "click_rate": round(clicked / opened * 100, 1) if opened > 0 else 0,
        "bounce_rate": round(bounced / total * 100, 1) if total > 0 else 0,
    }

    summary = f"Last {days} days: {total} emails sent, {metrics['delivery_rate']}% delivered, " \
              f"{metrics['open_rate']}% opened, {metrics['click_rate']}% clicked"

    return {
        "content": [{"type": "text", "text": summary}],
        "structuredContent": {"metrics": metrics, "period_days": days},
        "_meta": {
            "ui": {
                "resourceUri": "ui://widget/analytics-summary.html",
                "visibility": ["app", "model"],
            },
        },
    }


# --------------------------------------------------------------------------
# Widget HTML Templates
# --------------------------------------------------------------------------

def _get_target_list_widget() -> str:
    """Return target list widget HTML using MCP Apps SDK."""
    return """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            padding: 12px;
        }
        .dark { background: #1a1a1a; color: #e5e5e5; }
        .target-list { display: flex; flex-direction: column; gap: 8px; }
        .target {
            display: flex;
            align-items: center;
            padding: 12px;
            border-radius: 8px;
            background: #f5f5f5;
            cursor: pointer;
            transition: background 0.15s;
        }
        .dark .target { background: #2a2a2a; }
        .target:hover { background: #e8e8e8; }
        .dark .target:hover { background: #3a3a3a; }
        .target.loading { opacity: 0.6; pointer-events: none; }
        .target-info { flex: 1; min-width: 0; }
        .target-name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .target-email { font-size: 12px; color: #666; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dark .target-email { color: #999; }
        .stage {
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 500;
            white-space: nowrap;
        }
        .stage-0 { background: #fee2e2; color: #991b1b; }
        .stage-1 { background: #fef3c7; color: #92400e; }
        .stage-2 { background: #dbeafe; color: #1e40af; }
        .stage-3 { background: #e0e7ff; color: #3730a3; }
        .stage-4 { background: #d1fae5; color: #065f46; }
        .stage-5 { background: #059669; color: white; }
        .stage-6 { background: #7c3aed; color: white; }
        .error { padding: 12px; background: #fee2e2; color: #991b1b; border-radius: 8px; }
        .empty { padding: 24px; text-align: center; color: #666; }
    </style>
</head>
<body>
    <div id="root"></div>
    <script type="module">
        import { App, applyDocumentTheme } from 'https://esm.sh/@modelcontextprotocol/ext-apps';

        const root = document.getElementById('root');
        let targets = [];
        let pendingId = null;

        // Create MCP App instance
        const app = new App({ name: 'Target List', version: '1.0.0' });

        function applyTheme(theme) {
            if (theme === 'dark') {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
        }

        function render() {
            if (!targets.length) {
                root.innerHTML = '<div class="empty">No leads found</div>';
                return;
            }

            root.innerHTML = '<div class="target-list">' + targets.map(t => `
                <div class="target ${pendingId === t.id ? 'loading' : ''}" data-id="${t.id}">
                    <div class="target-info">
                        <div class="target-name">${t.name || 'Unknown'}</div>
                        <div class="target-email">${t.email}</div>
                    </div>
                    <span class="stage stage-${t.lifecycle_stage}">${t.lifecycle_stage_name || 'Stage ' + t.lifecycle_stage}</span>
                </div>
            `).join('') + '</div>';

            root.querySelectorAll('.target').forEach(el => {
                el.addEventListener('click', async () => {
                    if (pendingId) return;
                    const id = el.dataset.id;
                    pendingId = id;
                    render();
                    try {
                        await app.callServerTool({ name: 'get_target', arguments: { target_id: id } });
                    } catch (e) {
                        console.error(e);
                    } finally {
                        pendingId = null;
                        render();
                    }
                });
            });
        }

        // Register handlers BEFORE connect
        app.ontoolresult = (params) => {
            const data = params.structuredContent || params;
            targets = data?.targets || [];
            render();
        };

        app.onhostcontextchanged = (ctx) => {
            if (ctx.theme) applyTheme(ctx.theme);
        };

        // Connect and apply initial state
        app.connect().then(() => {
            const ctx = app.getHostContext();
            if (ctx?.theme) applyTheme(ctx.theme);
        });
    </script>
</body>
</html>"""


def _get_analytics_widget() -> str:
    """Return analytics summary widget HTML using MCP Apps SDK."""
    return """<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            padding: 16px;
        }
        .dark { background: #1a1a1a; color: #e5e5e5; }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 12px;
        }
        .stat {
            padding: 16px;
            border-radius: 8px;
            background: #f5f5f5;
        }
        .dark .stat { background: #2a2a2a; }
        .stat-value {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .stat-label { font-size: 12px; color: #666; }
        .dark .stat-label { color: #999; }
        .stat.primary { background: #059669; color: white; }
        .stat.primary .stat-label { color: rgba(255,255,255,0.8); }
        .rate-bar {
            margin-top: 16px;
            padding: 12px;
            background: #f5f5f5;
            border-radius: 8px;
        }
        .dark .rate-bar { background: #2a2a2a; }
        .bar-label { font-size: 12px; color: #666; margin-bottom: 4px; }
        .dark .bar-label { color: #999; }
        .bar-container {
            height: 8px;
            background: #e0e0e0;
            border-radius: 4px;
            overflow: hidden;
        }
        .dark .bar-container { background: #444; }
        .bar-fill {
            height: 100%;
            border-radius: 4px;
            transition: width 0.3s;
        }
        .bar-fill.green { background: #059669; }
        .bar-fill.blue { background: #3b82f6; }
        .bar-fill.purple { background: #7c3aed; }
        .loading { padding: 24px; text-align: center; color: #666; }
    </style>
</head>
<body>
    <div id="root"><div class="loading">Loading...</div></div>
    <script type="module">
        import { App } from 'https://esm.sh/@modelcontextprotocol/ext-apps';

        const root = document.getElementById('root');

        // Create MCP App instance
        const app = new App({ name: 'Analytics Summary', version: '1.0.0' });

        function applyTheme(theme) {
            if (theme === 'dark') {
                document.body.classList.add('dark');
            } else {
                document.body.classList.remove('dark');
            }
        }

        function render(metrics, days) {
            root.innerHTML = `
                <div class="stats-grid">
                    <div class="stat primary">
                        <div class="stat-value">${(metrics.total_sent || 0).toLocaleString()}</div>
                        <div class="stat-label">Emails Sent (${days}d)</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${(metrics.delivered || 0).toLocaleString()}</div>
                        <div class="stat-label">Delivered</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${(metrics.opened || 0).toLocaleString()}</div>
                        <div class="stat-label">Opened</div>
                    </div>
                    <div class="stat">
                        <div class="stat-value">${(metrics.clicked || 0).toLocaleString()}</div>
                        <div class="stat-label">Clicked</div>
                    </div>
                </div>
                <div class="rate-bar">
                    <div class="bar-label">Delivery Rate: ${metrics.delivery_rate || 0}%</div>
                    <div class="bar-container">
                        <div class="bar-fill green" style="width: ${metrics.delivery_rate || 0}%"></div>
                    </div>
                </div>
                <div class="rate-bar">
                    <div class="bar-label">Open Rate: ${metrics.open_rate || 0}%</div>
                    <div class="bar-container">
                        <div class="bar-fill blue" style="width: ${metrics.open_rate || 0}%"></div>
                    </div>
                </div>
                <div class="rate-bar">
                    <div class="bar-label">Click Rate: ${metrics.click_rate || 0}%</div>
                    <div class="bar-container">
                        <div class="bar-fill purple" style="width: ${metrics.click_rate || 0}%"></div>
                    </div>
                </div>
            `;
        }

        // Register handlers BEFORE connect
        app.ontoolresult = (params) => {
            const data = params.structuredContent || params;
            const metrics = data?.metrics || {};
            const days = data?.period_days || 30;
            render(metrics, days);
        };

        app.onhostcontextchanged = (ctx) => {
            if (ctx.theme) applyTheme(ctx.theme);
        };

        // Connect and apply initial state
        app.connect().then(() => {
            const ctx = app.getHostContext();
            if (ctx?.theme) applyTheme(ctx.theme);
        });
    </script>
</body>
</html>"""


# --------------------------------------------------------------------------
# Personalization Tools
# --------------------------------------------------------------------------

async def _tool_get_step_content(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Get step content with personalization settings."""
    step_id = args.get("step_id")
    if not step_id:
        raise ValueError("step_id is required")

    step = await SequenceQueries.get_step(db, UUID(step_id))
    if not step:
        return {
            "content": [{"type": "text", "text": "Step not found."}],
            "isError": True,
        }

    builder_content = step.get("builder_content") or {}

    # Extract blocks with their personalization settings
    blocks_summary = []
    for block_id, block in builder_content.items():
        personalization = block.get("data", {}).get("personalization", {})
        blocks_summary.append({
            "block_id": block_id,
            "type": block.get("type"),
            "has_personalization": personalization.get("enabled", False),
            "prompt": personalization.get("prompt", "") if personalization.get("enabled") else None,
        })

    personalized_count = sum(1 for b in blocks_summary if b["has_personalization"])

    return {
        "content": [
            {"type": "text", "text": f"Step has {len(blocks_summary)} blocks, {personalized_count} with personalization enabled."}
        ],
        "structuredContent": {
            "step_id": str(step["id"]),
            "subject": step.get("subject"),
            "blocks": blocks_summary,
            "builder_content": builder_content,
        },
    }


async def _tool_set_block_personalization(
    args: dict[str, Any],
    org_id: str,
    db: Any,
) -> dict[str, Any]:
    """Set personalization settings for a block."""
    step_id = args.get("step_id")
    block_id = args.get("block_id")
    enabled = args.get("enabled")

    if not step_id:
        raise ValueError("step_id is required")
    if not block_id:
        raise ValueError("block_id is required")
    if enabled is None:
        raise ValueError("enabled is required")

    step = await SequenceQueries.get_step(db, UUID(step_id))
    if not step:
        return {
            "content": [{"type": "text", "text": "Step not found."}],
            "isError": True,
        }

    builder_content = step.get("builder_content") or {}
    if block_id not in builder_content:
        return {
            "content": [{"type": "text", "text": f"Block {block_id} not found in step."}],
            "isError": True,
        }

    # Update personalization settings
    block = builder_content[block_id]
    if "data" not in block:
        block["data"] = {}

    block["data"]["personalization"] = {
        "enabled": enabled,
        "prompt": args.get("prompt", "") if enabled else "",
    }

    # Save updated builder_content
    updated_step = await SequenceQueries.update_step(
        db,
        UUID(step_id),
        builder_content=json.dumps(builder_content),
        has_unpublished_changes=True,
    )

    action = "enabled" if enabled else "disabled"
    return {
        "content": [
            {"type": "text", "text": f"Personalization {action} for block {block_id}."}
        ],
        "structuredContent": {
            "step_id": str(step_id),
            "block_id": block_id,
            "personalization": block["data"]["personalization"],
        },
    }


async def _tool_preview_block_personalization(
    args: dict[str, Any],
    org_id: str,
    db: Any,
    maven: Any,
) -> dict[str, Any]:
    """Preview personalization output for a block without scheduling."""
    step_id = args.get("step_id")
    block_id = args.get("block_id")
    target_id = args.get("target_id")

    if not step_id:
        raise ValueError("step_id is required")
    if not block_id:
        raise ValueError("block_id is required")
    if not target_id:
        raise ValueError("target_id is required")

    # Get step
    step = await SequenceQueries.get_step(db, UUID(step_id))
    if not step:
        return {
            "content": [{"type": "text", "text": "Step not found."}],
            "isError": True,
        }

    builder_content = step.get("builder_content") or {}
    if block_id not in builder_content:
        return {
            "content": [{"type": "text", "text": f"Block {block_id} not found in step."}],
            "isError": True,
        }

    block = builder_content[block_id]
    personalization = block.get("data", {}).get("personalization", {})

    if not personalization.get("enabled"):
        return {
            "content": [{"type": "text", "text": "Personalization is not enabled for this block."}],
            "isError": True,
        }

    prompt = personalization.get("prompt", "")
    if not prompt.strip():
        return {
            "content": [{"type": "text", "text": "No personalization prompt set for this block."}],
            "isError": True,
        }

    # Get target
    target = await TargetQueries.get_by_id(db, UUID(target_id))
    if not target:
        return {
            "content": [{"type": "text", "text": "Target not found."}],
            "isError": True,
        }

    # Extract original content
    block_type = block.get("type")
    props = block.get("data", {}).get("props", {})
    original_content = props.get("text") or props.get("contents") or ""

    if not original_content:
        return {
            "content": [{"type": "text", "text": "Block has no content to personalize."}],
            "isError": True,
        }

    # Generate preview via Maven
    try:
        target_data = {
            "email": target.get("email"),
            "first_name": target.get("first_name"),
            "last_name": target.get("last_name"),
            "company": target.get("company"),
        }
        # Include metadata if present
        if target.get("metadata"):
            target_data["metadata"] = target["metadata"]

        result = await maven.invoke_skill(
            "envoy-content-generation",
            {
                "mode": "block_personalization",
                "original_content": original_content,
                "prompt": prompt,
                "target": target_data,
                "block_type": block_type,
            },
        )

        personalized = result.get("body") or result.get("content") or original_content

        return {
            "content": [
                {"type": "text", "text": f"**Original:**\n{original_content}\n\n**Personalized for {target.get('email')}:**\n{personalized}"}
            ],
            "structuredContent": {
                "original": original_content,
                "personalized": personalized,
                "target": {
                    "id": str(target["id"]),
                    "email": target.get("email"),
                    "name": f"{target.get('first_name', '')} {target.get('last_name', '')}".strip(),
                },
            },
        }

    except Exception as e:
        return {
            "content": [{"type": "text", "text": f"Personalization preview failed: {e}"}],
            "isError": True,
        }

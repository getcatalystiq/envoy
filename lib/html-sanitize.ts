/**
 * Allowlist-based HTML sanitizer for email content.
 *
 * Email bodies are assembled from UNTRUSTED sources: AI-generated copy from the
 * Twin agent and recipient-controlled template variables (first_name, company,
 * …) that originate from webhook ingestion. Rendering any of that into email
 * HTML without sanitization is a stored-XSS / phishing vector.
 *
 * We use `sanitize-html`, an allowlist parser-based sanitizer: any tag not in
 * `allowedTags` is dropped, any attribute not in the per-tag allowlist is
 * dropped, and URL-bearing attributes (href/src/…) are scheme-checked against
 * `allowedSchemes`. Executable/structural tags (script, style, iframe, …) are
 * dropped along with their contents. This is fundamentally safer than a regex
 * denylist, which is trivially bypassed (`<iframe src=javascript:…>`, `<base>`,
 * `<meta http-equiv=refresh>`, tab/control-char obfuscation, etc.).
 */

import sanitizeHtml from "sanitize-html";

// Formatting + layout tags that are safe in an email body. Deliberately EXCLUDES
// script, style, iframe, form, base, meta, object, embed, link, input — i.e.
// every tag that can execute, redirect, or exfiltrate.
const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup",
  "del", "div", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5",
  "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "s",
  "small", "span", "strike", "strong", "sub", "sup", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "u", "ul",
];

// Presentational attributes safe on any allowed tag. `style` is permitted (email
// relies on inline styles); sanitize-html HTML-encodes attribute values, and CSS
// cannot execute script in modern mail clients. `on*` handlers are NOT listed, so
// they are stripped.
const BASE_ATTRS = [
  "style", "class", "align", "dir", "title", "width", "height", "valign",
  "bgcolor", "colspan", "rowspan",
];

// sanitize-html unions the `*` (all-tags) allowlist with each tag-specific list,
// so `a`/`img`/… get BASE_ATTRS PLUS their URL/structural attributes. URL-bearing
// attributes (href/src) are scheme-checked against allowedSchemes below.
const EMAIL_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    "*": BASE_ATTRS,
    a: ["href", "target", "rel"],
    img: ["src", "alt"],
    table: ["border", "cellpadding", "cellspacing", "role"],
    col: ["span"],
    colgroup: ["span"],
  },
  // Only web + mail schemes. Everything else (javascript:, data:, vbscript:,
  // file:, and any obfuscated variant) fails the check and the attribute is
  // dropped. Applies to href, src, and every other URL-bearing attribute.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href", "src"],
  // Drop disallowed tags entirely (not just unwrap); script/style/etc. take
  // their text content with them via the default nonTextTags handling.
  disallowedTagsMode: "discard",
};

/**
 * Sanitize an HTML fragment for safe inclusion in an outbound email body.
 * Returns "" for empty/falsy input.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return "";
  return sanitizeHtml(html, EMAIL_SANITIZE_OPTIONS);
}

/**
 * Sanitize a body that is already a full `<!doctype>` HTML document. This is a
 * fragment sanitizer and drops document structure, so we extract the <body>
 * inner HTML (falling back to stripping the doc skeleton) and run THAT through
 * the fragment sanitizer. Safety rests on sanitizeEmailHtml — the extraction
 * only chooses what to sanitize, and any imperfection still fails safe because
 * the result is always allowlist-sanitized. Returns the sanitized inner HTML
 * (a fragment); the caller re-wraps it in a clean document.
 */
export function sanitizeEmailDocumentInner(
  html: string | null | undefined,
): string {
  if (!html) return "";
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const inner = bodyMatch
    ? bodyMatch[1]
    : html
        .replace(/<!doctype[^>]*>/gi, "")
        .replace(/<head[\s\S]*?<\/head>/gi, "")
        .replace(/<\/?(?:html|body)[^>]*>/gi, "");
  return sanitizeEmailHtml(inner);
}

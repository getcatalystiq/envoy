/**
 * Allowlist-based HTML sanitizer for email content.
 *
 * Email bodies are assembled from UNTRUSTED sources: AI-generated copy from the
 * Twin agent and recipient-controlled template variables (first_name, company,
 * …) that originate from webhook ingestion. Rendering any of that into email
 * HTML without sanitization is a stored-XSS / phishing vector.
 *
 * We use `insane`, an allowlist parser-based sanitizer: any tag not in
 * `allowedTags` is dropped along with its contents, any attribute not in the
 * per-tag allowlist is dropped, and URL-bearing attributes (href/src/…) are
 * scheme-checked against `allowedSchemes`. This is fundamentally safer than a
 * regex denylist, which is trivially bypassed (`<iframe src=javascript:…>`,
 * `<base>`, `<meta http-equiv=refresh>`, tab/control-char obfuscation, etc.).
 */

import insane from "insane";

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
// relies on inline styles); insane HTML-encodes attribute values, and CSS cannot
// execute script in modern mail clients. `on*` handlers are NOT listed, so they
// are stripped.
const BASE_ATTRS = [
  "style", "class", "align", "dir", "title", "width", "height", "valign",
  "bgcolor", "colspan", "rowspan",
];

function buildAllowedAttributes(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const tag of ALLOWED_TAGS) {
    map[tag] = [...BASE_ATTRS];
  }
  // URL-bearing attributes — insane scheme-checks these against allowedSchemes.
  map.a = [...BASE_ATTRS, "href", "target", "rel"];
  map.img = [...BASE_ATTRS, "src", "alt"];
  map.table = [...BASE_ATTRS, "border", "cellpadding", "cellspacing", "role"];
  map.col = [...BASE_ATTRS, "span"];
  map.colgroup = [...BASE_ATTRS, "span"];
  return map;
}

const EMAIL_SANITIZE_OPTIONS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: buildAllowedAttributes(),
  // Only web + mail schemes. Everything else (javascript:, data:, vbscript:,
  // file:, and any obfuscated variant) fails the check and the attribute is
  // dropped.
  allowedSchemes: ["http", "https", "mailto"],
  allowedClasses: {},
  filter: null,
  transformText: null,
};

/**
 * Sanitize an HTML fragment for safe inclusion in an outbound email body.
 * Returns "" for empty/falsy input.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return "";
  return insane(html, EMAIL_SANITIZE_OPTIONS);
}

/**
 * Sanitize a body that is already a full `<!doctype>` HTML document. insane is a
 * fragment sanitizer and mangles document structure, so we extract the <body>
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

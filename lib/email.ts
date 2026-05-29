import {
  sanitizeEmailHtml,
  sanitizeEmailDocumentInner,
} from "@/lib/html-sanitize";

function buildDocument(innerHtml: string): string {
  return `<!DOCTYPE html>
<html style="height: 100%;">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; height: 100%;">
${innerHtml}
</body>
</html>`;
}

/**
 * Wrap an email body fragment in the outer HTML document we send to recipients.
 *
 * The body is treated as UNTRUSTED and sanitized by default — this is the single
 * choke point every send path flows through (outbox approve/retry, bulk-approve,
 * direct send, content preview, the email-sender cron, and campaign-executor
 * output once it reaches the sender).
 *
 *  - A plain fragment is allowlist-sanitized then wrapped.
 *  - A body that is already a full `<!doctype>` document is NOT trusted just
 *    because it looks complete (an untrusted AI body could forge a `<!doctype`
 *    prefix to dodge a fragment-only sanitizer): its <body> inner HTML is
 *    extracted, sanitized, and re-wrapped in a clean document.
 *  - `opts.sanitized: true` opts out entirely — used only by the block-compiler
 *    path, whose fragment is already sanitized per block and carries trusted
 *    MSO/Outlook conditional comments the sanitizer would otherwise strip.
 */
export function wrapEmailBody(
  body: string,
  opts: { sanitized?: boolean } = {},
): string {
  if (!body) return body;

  const stripped = body.trim();

  if (stripped.toLowerCase().startsWith("<!doctype")) {
    if (opts.sanitized) return body;
    return buildDocument(sanitizeEmailDocumentInner(body));
  }

  const safeBody = opts.sanitized ? body : sanitizeEmailHtml(body);
  return buildDocument(safeBody);
}

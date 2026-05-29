import { describe, it, expect } from "vitest";
import { wrapEmailBody } from "@/lib/email";

describe("wrapEmailBody", () => {
  it("sanitizes a raw fragment before wrapping it", () => {
    const fragment = `<p>Hello <strong>world</strong></p><script>alert('xss')</script>`;
    const out = wrapEmailBody(fragment);

    // Wrapped in the outer document.
    expect(out.toLowerCase()).toContain("<!doctype html>");
    expect(out).toContain('<body style="margin: 0; padding: 0; height: 100%;">');

    // Safe content survives.
    expect(out).toContain("<p>Hello <strong>world</strong></p>");

    // The script tag (and its contents) is stripped by the sanitizer.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("alert('xss')");
  });

  it("sanitizes a full <!doctype> document (a forged doctype body cannot skip sanitization)", () => {
    const fullDoc = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><script>tracker()</script></head>
<body><p>Pre-wrapped</p><img src=x onerror="steal()"></body>
</html>`;
    const out = wrapEmailBody(fullDoc);

    // Document skeleton + safe content preserved...
    expect(out.toLowerCase()).toContain("<!doctype html>");
    expect(out).toContain("<p>Pre-wrapped</p>");
    // ...but executable/dangerous content is stripped.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("tracker()");
    expect(out).not.toContain("onerror");
  });

  it("returns a full <!doctype> document unchanged when opts.sanitized is true", () => {
    const fullDoc = `<!DOCTYPE html><html><body><p>Trusted</p></body></html>`;
    // Our own already-sanitized wrapped docs opt out of re-processing.
    expect(wrapEmailBody(fullDoc, { sanitized: true })).toBe(fullDoc);
  });

  it("detects a full document case-insensitively and after leading whitespace, then sanitizes it", () => {
    const fullDoc = `\n   <!doctype HTML><html><body>x<script>bad()</script></body></html>`;
    const out = wrapEmailBody(fullDoc);
    expect(out.toLowerCase()).toContain("<!doctype");
    expect(out).toContain("x");
    expect(out).not.toContain("bad()");
  });

  it("skips sanitization when opts.sanitized is true (MSO conditional comments preserved)", () => {
    const fragment = `<!--[if mso]><table role="presentation"><tr><td>Outlook</td></tr></table><![endif]-->
<p>Body</p>`;
    const out = wrapEmailBody(fragment, { sanitized: true });

    // Wrapped, and the trusted MSO conditional comment is preserved verbatim.
    expect(out.toLowerCase()).toContain("<!doctype html>");
    expect(out).toContain("<!--[if mso]>");
    expect(out).toContain("<![endif]-->");
    expect(out).toContain("<p>Body</p>");
  });

  it("strips MSO conditional comments when sanitization is NOT skipped", () => {
    const fragment = `<!--[if mso]><table role="presentation"><tr><td>Outlook</td></tr></table><![endif]-->
<p>Body</p>`;
    const out = wrapEmailBody(fragment);

    // Default path sanitizes: the conditional comment markers are stripped.
    expect(out).not.toContain("<!--[if mso]>");
    expect(out).not.toContain("<![endif]-->");
    expect(out).toContain("<p>Body</p>");
  });

  it("returns an empty body unchanged (no wrapping)", () => {
    expect(wrapEmailBody("")).toBe("");
  });
});

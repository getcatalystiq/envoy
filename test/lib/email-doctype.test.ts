import { describe, it, expect } from "vitest";
import { wrapEmailBody } from "@/lib/email";

/**
 * Regression coverage for the doctype-sanitization bypass in `wrapEmailBody`.
 *
 * An untrusted AI body could forge a `<!doctype>` prefix to dodge a
 * fragment-only sanitizer. The doctype branch must still extract the body,
 * sanitize it through the REAL allowlist sanitizer, and re-wrap it — except
 * when the caller explicitly asserts `opts.sanitized: true`. These tests use
 * the real `lib/html-sanitize` (no mocks) so the regression is exercised
 * end-to-end.
 */
describe("wrapEmailBody doctype-bypass regression", () => {
  it("sanitizes a forged-doctype body: drops <head> <script>, strips on* handlers, keeps text", () => {
    const body =
      '<!DOCTYPE html><html><head><script>evil()</script></head>' +
      '<body><p>hi</p><img src=x onerror="x()"></body></html>';

    const out = wrapEmailBody(body);

    // Safe text content survives the round-trip.
    expect(out).toContain("hi");

    // Executable / dangerous content is removed by the real sanitizer.
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("evil()");
    expect(out).not.toContain("onerror");
  });

  it("returns a doctype body byte-for-byte unchanged when opts.sanitized is true", () => {
    const body =
      '<!DOCTYPE html><html><head><script>evil()</script></head>' +
      '<body><p>hi</p><img src=x onerror="x()"></body></html>';

    // The trusted opt-out must not touch the input at all.
    expect(wrapEmailBody(body, { sanitized: true })).toBe(body);
  });

  it("sanitizes a doctype body with NO <body> tag via the skeleton-strip fallback", () => {
    const body = "<!doctype html><script>bad()</script><p>ok</p>";

    const out = wrapEmailBody(body);

    // Body-inner extraction misses (no <body>), so the fallback strips the
    // doc skeleton then sanitizes the remainder.
    expect(out).toContain("ok");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("bad()");
  });
});

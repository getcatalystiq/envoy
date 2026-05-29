import { describe, it, expect } from "vitest";
import { wrapEmailBody } from "@/lib/email";

describe("lib/email", () => {
  it("returns empty input unchanged", () => {
    expect(wrapEmailBody("")).toBe("");
  });

  it("wraps plain HTML fragment in a full document", () => {
    const out = wrapEmailBody("<p>Hello</p>");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<p>Hello</p>");
    expect(out).toMatch(/<html[^>]*>/);
    expect(out).toContain("</html>");
  });

  it("does NOT double-wrap when input already starts with <!doctype>", () => {
    const input = "<!doctype html><html><body>Already wrapped</body></html>";
    expect(wrapEmailBody(input)).toBe(input);
  });

  it("doctype check is case-insensitive and tolerates leading whitespace", () => {
    const input = "  <!DOCTYPE html><html></html>";
    expect(wrapEmailBody(input)).toBe(input);
  });
});

import { describe, it, expect } from "vitest";
import { compileBuilderContent } from "@/lib/block-compiler";

describe("lib/block-compiler", () => {
  it("returns empty string for null/empty input", () => {
    expect(compileBuilderContent(null as never)).toBe("");
    expect(compileBuilderContent({})).toBe("");
  });

  it("returns empty string when root block is missing", () => {
    expect(compileBuilderContent({ other: { type: "Text" } } as never)).toBe("");
  });

  it("renders a Text block to HTML", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["t1"] } } },
      t1: { type: "Text", data: { props: { text: "Hello" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).toContain("Hello");
  });

  it("renders Heading and Button blocks", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["h", "b"] } } },
      h: { type: "Heading", data: { props: { text: "Title" } } },
      b: { type: "Button", data: { props: { text: "Click", url: "https://example.com" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).toContain("Title");
    expect(html).toContain("Click");
    expect(html).toContain("https://example.com");
  });

  it("Text strips <script> tags via sanitizeHtml (marked + sanitize)", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["t"] } } },
      t: { type: "Text", data: { props: { text: "Hello<script>alert(1)</script>World" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("Hello");
    expect(html).toContain("World");
  });

  it("Heading escapes HTML special characters", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["h"] } } },
      h: { type: "Heading", data: { props: { text: "<script>x</script>" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>x</script>");
  });

  it("renders Html block contents verbatim (already sanitized upstream)", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["h"] } } },
      h: { type: "Html", data: { props: { contents: "<p>Raw <b>HTML</b></p>" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).toContain("<p>Raw <b>HTML</b></p>");
  });

  it("renders Image block with sanitized src", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["i"] } } },
      i: { type: "Image", data: { props: { url: "https://cdn.example.com/x.png", alt: "alt" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html).toContain("https://cdn.example.com/x.png");
    expect(html).toContain("alt=\"alt\"");
  });

  it("rejects javascript: URLs in Image src", () => {
    const content = {
      root: { type: "Container", data: { props: { childrenIds: ["i"] } } },
      i: { type: "Image", data: { props: { url: "javascript:alert(1)", alt: "x" } } },
    };
    const html = compileBuilderContent(content as never);
    expect(html.toLowerCase()).not.toContain("javascript:alert");
  });

  it("supports custom rootBlockId argument", () => {
    const content = {
      mainRoot: { type: "Container", data: { props: { childrenIds: ["t"] } } },
      t: { type: "Text", data: { props: { text: "Custom Root" } } },
    };
    const html = compileBuilderContent(content as never, "mainRoot");
    expect(html).toContain("Custom Root");
  });
});

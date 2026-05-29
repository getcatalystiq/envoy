import { describe, it, expect } from "vitest";
import { replaceTemplatesInBlocks } from "@/lib/template-engine";

describe("lib/template-engine", () => {
  it("replaces {{first_name}} etc. in Text/Heading/Button blocks", () => {
    const input = {
      b1: { type: "Text", data: { props: { text: "Hi {{first_name}}!" } } },
      b2: { type: "Heading", data: { props: { text: "{{company}} update" } } },
      b3: { type: "Button", data: { props: { text: "Hello {{title}}" } } },
    };
    const result = replaceTemplatesInBlocks(
      input,
      { first_name: "Alice", company: "Acme", title: "VP" },
      "target-1",
    );
    expect(result.b1.data.props.text).toBe("Hi Alice!");
    expect(result.b2.data.props.text).toBe("Acme update");
    expect(result.b3.data.props.text).toBe("Hello VP");
  });

  it("replaces in Html block contents prop", () => {
    const input = {
      h: { type: "Html", data: { props: { contents: "<p>Hi {{first_name}}</p>" } } },
    };
    const result = replaceTemplatesInBlocks(input, { first_name: "Bob" }, "t1");
    expect(result.h.data.props.contents).toBe("<p>Hi Bob</p>");
  });

  it("substitutes unsubscribe_link with NEXT_PUBLIC_URL", () => {
    const input = {
      b: { type: "Text", data: { props: { text: "Unsubscribe: {{unsubscribe_link}}" } } },
    };
    const result = replaceTemplatesInBlocks(input, {}, "tgt-42");
    expect(result.b.data.props.text).toContain("http://localhost:3000/unsubscribe/tgt-42");
  });

  it("leaves unknown variables intact", () => {
    const input = {
      b: { type: "Text", data: { props: { text: "{{unknown}}" } } },
    };
    const result = replaceTemplatesInBlocks(input, {}, "t");
    expect(result.b.data.props.text).toBe("{{unknown}}");
  });

  it("uses empty string for null/undefined target values", () => {
    const input = {
      b: { type: "Text", data: { props: { text: "Hi {{first_name}}" } } },
    };
    const result = replaceTemplatesInBlocks(input, { first_name: null }, "t");
    expect(result.b.data.props.text).toBe("Hi ");
  });

  it("does not mutate the input object (deep clone)", () => {
    const input = {
      b: { type: "Text", data: { props: { text: "{{first_name}}" } } },
    };
    const original = JSON.parse(JSON.stringify(input));
    replaceTemplatesInBlocks(input, { first_name: "Alice" }, "t");
    expect(input).toEqual(original);
  });

  it("skips blocks without props", () => {
    const input = {
      b: { type: "Text", data: {} },
    };
    const result = replaceTemplatesInBlocks(input as never, {}, "t");
    expect(result.b).toEqual({ type: "Text", data: {} });
  });

  it("skips unsupported block types", () => {
    const input = {
      img: { type: "Image", data: { props: { src: "{{first_name}}.png" } } },
    };
    const result = replaceTemplatesInBlocks(input as never, { first_name: "Alice" }, "t");
    expect(result.img.data.props.src).toBe("{{first_name}}.png"); // unchanged
  });
});

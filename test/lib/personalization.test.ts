import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the twin module so tests don't hit real fetch.
const runAgentJsonMock = vi.fn();
vi.mock("@/lib/agent-session", () => ({
  runAgentJson: (...args: unknown[]) => runAgentJsonMock(...args),
}));

import { processPersonalization, hasPersonalizedBlocks } from "@/lib/personalization";

function textBlock(text: string, personalization?: { enabled: boolean; prompt?: string }) {
  return {
    type: "Text",
    data: {
      props: { text },
      ...(personalization ? { personalization } : {}),
    },
  };
}

describe("lib/personalization", () => {
  beforeEach(() => {
    runAgentJsonMock.mockReset();
  });

  describe("hasPersonalizedBlocks", () => {
    it("returns false for null/empty", () => {
      expect(hasPersonalizedBlocks(null)).toBe(false);
      expect(hasPersonalizedBlocks(undefined)).toBe(false);
      expect(hasPersonalizedBlocks({})).toBe(false);
    });

    it("returns true when any block has personalization.enabled=true", () => {
      const content = {
        b1: textBlock("a", { enabled: false }),
        b2: textBlock("b", { enabled: true, prompt: "p" }),
      };
      expect(hasPersonalizedBlocks(content)).toBe(true);
    });

    it("returns false when no block has personalization enabled", () => {
      const content = {
        b1: textBlock("a"),
        b2: textBlock("b", { enabled: false }),
      };
      expect(hasPersonalizedBlocks(content)).toBe(false);
    });
  });

  describe("processPersonalization", () => {
    it("skips blocks without personalization", async () => {
      const content = {
        b1: textBlock("hello"),
      };
      const result = await processPersonalization(content, {}, "agent-1", "env-1");
      expect(result.content.b1.data.props.text).toBe("hello");
      expect(result.errors).toEqual([]);
      expect(runAgentJsonMock).not.toHaveBeenCalled();
    });

    it("personalizes blocks via runAgentJson body field", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ body: "Hi Alice!" });
      const content = {
        b1: textBlock("Hello there", { enabled: true, prompt: "Use the name" }),
      };
      const result = await processPersonalization(
        content,
        { first_name: "Alice", email: "a@b.com" },
        "agent-1",
        "env-1",
      );
      expect(result.content.b1.data.props.text).toBe("Hi Alice!");
      expect(result.errors).toEqual([]);
      expect(runAgentJsonMock).toHaveBeenCalledOnce();
    });

    it("falls back to content field when body absent", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ content: "fallback text" });
      const content = { b1: textBlock("original", { enabled: true }) };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      expect(result.content.b1.data.props.text).toBe("fallback text");
    });

    it("keeps original content when result has neither body nor content", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ irrelevant: "nope" });
      const content = { b1: textBlock("kept", { enabled: true }) };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      // Falls through to originalContent
      expect(result.content.b1.data.props.text).toBe("kept");
    });

    it("records an error when runAgentJson throws", async () => {
      runAgentJsonMock.mockRejectedValueOnce(new Error("Twin down"));
      const content = { b1: textBlock("kept", { enabled: true }) };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].blockId).toBe("b1");
      expect(result.errors[0].error).toContain("Twin down");
    });

    it("respects maxConcurrent semaphore — no more than N runAgentJson calls in flight at once", async () => {
      const maxConcurrent = 3;
      let inflight = 0;
      let observedMax = 0;
      runAgentJsonMock.mockImplementation(async () => {
        inflight++;
        observedMax = Math.max(observedMax, inflight);
        await new Promise((r) => setTimeout(r, 10));
        inflight--;
        return { body: "ok" };
      });

      const content: Record<string, ReturnType<typeof textBlock>> = {};
      for (let i = 0; i < 10; i++) {
        content[`b${i}`] = textBlock(`orig ${i}`, { enabled: true });
      }

      await processPersonalization(content, {}, "a1", "env-1", { maxConcurrent });
      expect(observedMax).toBeLessThanOrEqual(maxConcurrent);
      expect(observedMax).toBeGreaterThan(0);
    });

    it("passes block type, original content, additional instructions, and target into the prompt", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ body: "personalized" });
      const content = {
        b1: textBlock("Original Body", { enabled: true, prompt: "Be witty" }),
      };
      await processPersonalization(
        content,
        { first_name: "X", last_name: "Y", company: "Acme", email: "x@y.com" },
        "agent-1",
        "env-1",
      );
      const callArgs = runAgentJsonMock.mock.calls[0];
      const message = callArgs[2] as string;
      expect(message).toContain("Text");
      expect(message).toContain("Original Body");
      expect(message).toContain("Be witty");
      expect(message).toContain("Acme");
      expect(message).toContain("first_name");
    });

    it("sanitizes target — drops disallowed fields, clamps strings and metadata", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ body: "ok" });
      const longString = "x".repeat(2000);
      const target = {
        first_name: "Alice",
        // disallowed top-level
        internal_secret: "should-not-ship",
        // very long string clamped to 100
        company: longString,
        metadata: {
          industry: "tech",
          // metadata strings clamped to 500
          notes: longString,
          // disallowed value type filtered out
          nested_obj: { a: 1 },
          // array clamped to 20 items + element types restricted
          tags: Array.from({ length: 50 }, (_, i) => `t${i}`),
        },
      };
      const content = { b1: textBlock("o", { enabled: true }) };
      await processPersonalization(content, target, "agent-1", "env-1");
      const sentMessage = runAgentJsonMock.mock.calls[0][2] as string;
      expect(sentMessage).not.toContain("internal_secret");
      expect(sentMessage).not.toContain("should-not-ship");
      // Long company string truncated to 100 chars
      const companyMatch = sentMessage.match(/"company"\s*:\s*"(x+)"/);
      expect(companyMatch).toBeTruthy();
      expect(companyMatch?.[1].length).toBe(100);
      // metadata notes truncated to 500
      const notesMatch = sentMessage.match(/"notes"\s*:\s*"(x+)"/);
      expect(notesMatch?.[1].length).toBe(500);
      // nested_obj dropped (only scalar/string/array values allowed in metadata)
      expect(sentMessage).not.toContain("nested_obj");
      // tags array clamped to 20
      const tagsMatch = sentMessage.match(/"tags"\s*:\s*\[([^\]]+)\]/);
      const tagCount = tagsMatch ? tagsMatch[1].split(",").length : 0;
      expect(tagCount).toBe(20);
    });

    it("parses metadata when given as a JSON string", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ body: "ok" });
      const target = {
        first_name: "X",
        metadata: JSON.stringify({ industry: "fintech" }),
      };
      const content = { b1: textBlock("o", { enabled: true }) };
      await processPersonalization(content, target, "agent-1", "env-1");
      const message = runAgentJsonMock.mock.calls[0][2] as string;
      expect(message).toContain("fintech");
    });

    it("returns blocks where extractBlockContent yields null unchanged (no AI call)", async () => {
      const content = {
        b1: {
          type: "Image",
          data: { props: {}, personalization: { enabled: true } },
        },
      };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      expect(runAgentJsonMock).not.toHaveBeenCalled();
      expect(result.content.b1).toEqual(content.b1);
    });

    it("supports Heading and Button block types", async () => {
      runAgentJsonMock.mockResolvedValue({ body: "personalized" });
      const content = {
        h1: { type: "Heading", data: { props: { text: "Hi" }, personalization: { enabled: true } } },
        b1: { type: "Button", data: { props: { text: "Click" }, personalization: { enabled: true } } },
      };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      expect(result.content.h1.data.props.text).toBe("personalized");
      expect(result.content.b1.data.props.text).toBe("personalized");
    });

    it("supports Html block type via contents prop", async () => {
      runAgentJsonMock.mockResolvedValueOnce({ body: "<p>new</p>" });
      const content = {
        h: { type: "Html", data: { props: { contents: "<p>old</p>" }, personalization: { enabled: true } } },
      };
      const result = await processPersonalization(content, {}, "a1", "env-1");
      expect(result.content.h.data.props.contents).toBe("<p>new</p>");
    });
  });
});

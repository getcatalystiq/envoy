import { describe, it, expect } from "vitest";
import { cn, jsonResponse } from "@/lib/utils";

describe("lib/utils", () => {
  describe("cn", () => {
    it("merges class strings", () => {
      expect(cn("a", "b", "c")).toBe("a b c");
    });

    it("dedupes conflicting Tailwind classes (later wins)", () => {
      expect(cn("px-2", "px-4")).toBe("px-4");
    });

    it("handles conditional classes", () => {
      const show: boolean = false;
      expect(cn("a", show && "b", "c")).toBe("a c");
      expect(cn({ a: true, b: false }, "c")).toBe("a c");
    });

    it("ignores undefined/null/empty values", () => {
      expect(cn("a", undefined, null, "", "b")).toBe("a b");
    });

    it("flattens arrays", () => {
      expect(cn(["a", "b"], "c")).toBe("a b c");
    });
  });

  describe("jsonResponse", () => {
    it("serializes body to JSON with default 200 status", async () => {
      const res = jsonResponse({ ok: true });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(await res.json()).toEqual({ ok: true });
    });

    it("respects custom status code", async () => {
      const res = jsonResponse({ error: "nope" }, 422);
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "nope" });
    });

    it("serializes null, arrays, primitives", async () => {
      expect(await jsonResponse(null).json()).toBeNull();
      expect(await jsonResponse([1, 2, 3]).json()).toEqual([1, 2, 3]);
      expect(await jsonResponse(42).json()).toBe(42);
    });
  });
});

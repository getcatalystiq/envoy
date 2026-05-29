import { describe, it, expect } from "vitest";
import {
  evaluateCondition,
  evaluateRule,
  GraduationError,
  InvalidRuleError,
} from "@/lib/graduation";

describe("lib/graduation", () => {
  describe("evaluateCondition", () => {
    const target = {
      status: "active",
      lifecycle_stage: 3,
      email: "x@y.com",
      first_name: "Alice",
      company: "Acme",
      custom_fields: { tier: "gold", score: 87 },
      metadata: { source: "linkedin" },
    };

    it("eq operator matches scalar equality", () => {
      expect(evaluateCondition(target, { field: "status", operator: "eq", value: "active" })).toBe(true);
      expect(evaluateCondition(target, { field: "status", operator: "eq", value: "paused" })).toBe(false);
    });

    it("ne operator", () => {
      expect(evaluateCondition(target, { field: "status", operator: "ne", value: "paused" })).toBe(true);
    });

    it("gt/gte/lt/lte for numeric", () => {
      const f = "lifecycle_stage";
      expect(evaluateCondition(target, { field: f, operator: "gt", value: 2 })).toBe(true);
      expect(evaluateCondition(target, { field: f, operator: "gt", value: 3 })).toBe(false);
      expect(evaluateCondition(target, { field: f, operator: "gte", value: 3 })).toBe(true);
      expect(evaluateCondition(target, { field: f, operator: "lt", value: 4 })).toBe(true);
      expect(evaluateCondition(target, { field: f, operator: "lte", value: 3 })).toBe(true);
    });

    it("gt/lt on non-numeric returns false (no coercion)", () => {
      expect(evaluateCondition(target, { field: "status", operator: "gt", value: 1 })).toBe(false);
    });

    it("contains operator on strings", () => {
      expect(evaluateCondition(target, { field: "email", operator: "contains", value: "@y.com" })).toBe(true);
      expect(evaluateCondition(target, { field: "email", operator: "contains", value: "missing" })).toBe(false);
    });

    it("contains operator on arrays", () => {
      const t = { custom_fields: { tags: ["a", "b", "c"] } };
      expect(evaluateCondition(t, { field: "custom_fields.tags", operator: "contains", value: "b" })).toBe(true);
      expect(evaluateCondition(t, { field: "custom_fields.tags", operator: "contains", value: "z" })).toBe(false);
    });

    it("exists operator", () => {
      expect(evaluateCondition(target, { field: "first_name", operator: "exists" })).toBe(true);
      expect(evaluateCondition({ first_name: null }, { field: "first_name", operator: "exists" })).toBe(false);
    });

    it("nested field access via dot notation", () => {
      expect(
        evaluateCondition(target, { field: "custom_fields.tier", operator: "eq", value: "gold" }),
      ).toBe(true);
      expect(
        evaluateCondition(target, { field: "metadata.source", operator: "eq", value: "linkedin" }),
      ).toBe(true);
    });

    it("rejects disallowed root field", () => {
      expect(() =>
        evaluateCondition(target, { field: "internal_secret", operator: "eq", value: "x" }),
      ).toThrow(InvalidRuleError);
    });

    it("rejects too-deep field paths", () => {
      expect(() =>
        evaluateCondition(target, {
          field: "metadata.a.b.c.d",
          operator: "eq",
          value: "x",
        }),
      ).toThrow(InvalidRuleError);
    });

    it("rejects private-field access (leading underscore)", () => {
      expect(() =>
        evaluateCondition(target, {
          field: "custom_fields._private",
          operator: "eq",
          value: "x",
        }),
      ).toThrow(InvalidRuleError);
    });

    it("rejects unknown operator", () => {
      expect(() =>
        evaluateCondition(target, { field: "status", operator: "between", value: 1 }),
      ).toThrow(InvalidRuleError);
    });

    it("returns false when value missing (null)", () => {
      expect(
        evaluateCondition({ status: null }, { field: "status", operator: "eq", value: "x" }),
      ).toBe(false);
    });
  });

  describe("evaluateRule", () => {
    const target = { status: "active", lifecycle_stage: 4, email: "a@b.com" };

    it("returns false on empty conditions", () => {
      expect(evaluateRule(target, [])).toBe(false);
    });

    it("returns true when all conditions match (AND semantics)", () => {
      expect(
        evaluateRule(target, [
          { field: "status", operator: "eq", value: "active" },
          { field: "lifecycle_stage", operator: "gte", value: 3 },
        ]),
      ).toBe(true);
    });

    it("returns false when any condition fails", () => {
      expect(
        evaluateRule(target, [
          { field: "status", operator: "eq", value: "active" },
          { field: "lifecycle_stage", operator: "eq", value: 99 },
        ]),
      ).toBe(false);
    });
  });

  describe("error classes", () => {
    it("are nameable + instanceable", () => {
      const e = new InvalidRuleError("test");
      expect(e.name).toBe("InvalidRuleError");
      expect(e instanceof GraduationError).toBe(true);
      expect(e instanceof Error).toBe(true);
    });
  });
});

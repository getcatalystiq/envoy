import { describe, it, expect } from "vitest";
import { sanitizeTargetForTwin } from "@/lib/twin-sanitize";

describe("sanitizeTargetForTwin", () => {
  it("keeps only allowlisted PII fields, dropping internal columns", () => {
    const row = {
      id: "uuid-123",
      organization_id: "org-1",
      target_type_id: "tt-1",
      segment_id: "seg-1",
      status: "active",
      created_at: "2026-01-01",
      updated_at: "2026-01-02",
      phone_normalized: "+15550000000",
      email: "a@b.com",
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines",
      role: "Engineer",
      phone: "555-0000",
    };
    const out = sanitizeTargetForTwin(row);
    expect(out).toEqual({
      email: "a@b.com",
      first_name: "Ada",
      last_name: "Lovelace",
      company: "Analytical Engines",
      role: "Engineer",
      phone: "555-0000",
    });
    // internal identifiers / timestamps never leave
    for (const k of [
      "id",
      "organization_id",
      "target_type_id",
      "segment_id",
      "status",
      "created_at",
      "updated_at",
      "phone_normalized",
    ]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("drops arbitrary custom_fields entirely", () => {
    const out = sanitizeTargetForTwin({
      email: "a@b.com",
      custom_fields: { ssn: "123-45-6789", api_token: "secret" },
    });
    expect(out).toEqual({ email: "a@b.com" });
    expect(JSON.stringify(out)).not.toContain("ssn");
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("clamps allowlisted strings to 100 chars", () => {
    const out = sanitizeTargetForTwin({ company: "x".repeat(500) });
    expect((out.company as string).length).toBe(100);
  });

  it("keeps lifecycle_stage including the falsy 0 stage", () => {
    expect(sanitizeTargetForTwin({ lifecycle_stage: 0 }).lifecycle_stage).toBe(0);
    expect(sanitizeTargetForTwin({ lifecycle_stage: 3 }).lifecycle_stage).toBe(3);
    expect(sanitizeTargetForTwin({}).lifecycle_stage).toBeUndefined();
  });

  it("clamps metadata strings to 500, arrays to 20, and drops nested objects", () => {
    const out = sanitizeTargetForTwin({
      metadata: {
        notes: "y".repeat(900),
        score: 42,
        active: true,
        empty: null,
        tags: Array.from({ length: 50 }, (_, i) => `t${i}`),
        nested_obj: { a: 1 },
      },
    });
    const meta = out.metadata as Record<string, unknown>;
    expect((meta.notes as string).length).toBe(500);
    expect(meta.score).toBe(42);
    expect(meta.active).toBe(true);
    expect(meta.empty).toBeNull();
    expect((meta.tags as unknown[]).length).toBe(20);
    expect(meta).not.toHaveProperty("nested_obj");
  });

  it("parses metadata supplied as a JSON string", () => {
    const out = sanitizeTargetForTwin({ metadata: JSON.stringify({ industry: "fintech" }) });
    expect((out.metadata as Record<string, unknown>).industry).toBe("fintech");
  });

  it("omits metadata when it has no usable scalar values", () => {
    const out = sanitizeTargetForTwin({ email: "a@b.com", metadata: { only: { nested: true } } });
    expect(out).not.toHaveProperty("metadata");
  });
});

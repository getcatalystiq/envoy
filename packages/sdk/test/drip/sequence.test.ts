import { describe, expect, it } from "vitest";

import { defineSequence, SequenceDefinitionError } from "@sdk/drip/sequence.js";

// U8 — defineSequence is pure data + loud definition-time validation (R12/R13/R15).

describe("defineSequence", () => {
  it("builds a frozen, positionally-indexed sequence", () => {
    const seq = defineSequence({
      key: "welcome",
      steps: [
        { templateId: "t0", waitDays: 0, aiSlots: ["GREETING"], brief: "warm" },
        { templateId: "t1", waitDays: 3, aiSlots: [], brief: "" },
      ],
    });
    expect(seq.key).toBe("welcome");
    expect(seq.steps).toHaveLength(2);
    expect(seq.steps[0]!.templateId).toBe("t0");
    expect(Object.isFrozen(seq)).toBe(true);
    expect(Object.isFrozen(seq.steps)).toBe(true);
    expect(Object.isFrozen(seq.steps[0])).toBe(true);
  });

  it("rejects an empty key", () => {
    expect(() => defineSequence({ key: "", steps: [{ templateId: "t", waitDays: 0, aiSlots: [], brief: "" }] })).toThrow(
      SequenceDefinitionError,
    );
  });

  it("rejects an empty step list", () => {
    expect(() => defineSequence({ key: "k", steps: [] })).toThrow(/at least one step/);
  });

  it("rejects a step with a missing templateId", () => {
    expect(() =>
      defineSequence({ key: "k", steps: [{ templateId: "", waitDays: 0, aiSlots: [], brief: "" }] }),
    ).toThrow(/templateId/);
  });

  it("rejects a negative or non-finite waitDays", () => {
    expect(() =>
      defineSequence({ key: "k", steps: [{ templateId: "t", waitDays: -1, aiSlots: [], brief: "" }] }),
    ).toThrow(/waitDays/);
    expect(() =>
      defineSequence({ key: "k", steps: [{ templateId: "t", waitDays: Infinity, aiSlots: [], brief: "" }] }),
    ).toThrow(/waitDays/);
  });

  it("rejects duplicate slot names within a step", () => {
    expect(() =>
      defineSequence({
        key: "k",
        steps: [{ templateId: "t", waitDays: 0, aiSlots: ["A", "A"], brief: "x" }],
      }),
    ).toThrow(/duplicate/);
  });

  it("rejects a step that declares aiSlots but has an empty brief", () => {
    expect(() =>
      defineSequence({ key: "k", steps: [{ templateId: "t", waitDays: 0, aiSlots: ["A"], brief: "  " }] }),
    ).toThrow(/empty brief/);
  });

  it("allows a fractional wait (sub-day)", () => {
    const seq = defineSequence({
      key: "k",
      steps: [{ templateId: "t", waitDays: 0.5, aiSlots: [], brief: "" }],
    });
    expect(seq.steps[0]!.waitDays).toBe(0.5);
  });
});

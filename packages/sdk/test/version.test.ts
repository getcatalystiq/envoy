import { describe, it, expect } from "vitest";
import { SDK_VERSION, getCapabilities } from "@sdk/index.js";
import pkg from "../package.json";

// U22 — the version + capability surface the consuming host's cutover gate reads. The host runs an
// immediate, no-fallback big-bang, so the gate is load-bearing: it must read TRUTH, not a hand-set
// constant. These tests are what make the capability flags non-lying — a regressed feature (e.g.
// attachments removed) breaks the exercise tests in test/drip/transactional.test.ts, and a drifted
// version breaks the assertion here, so the release cannot publish a flag that doesn't hold.
describe("version + capability surface (U22)", () => {
  it("SDK_VERSION is build-derived from package.json (no `0.0.0` placeholder drift)", () => {
    expect(SDK_VERSION).toBe(pkg.version);
    expect(SDK_VERSION).not.toBe("0.0.0");
  });

  it("getCapabilities reports the Phase-0 enhancements the host cutover gate asserts", () => {
    expect(getCapabilities()).toEqual({ attachments: true, systemLane: true });
  });

  it("the reported capabilities object is frozen (a caller cannot mutate reported capabilities)", () => {
    expect(Object.isFrozen(getCapabilities())).toBe(true);
  });
});

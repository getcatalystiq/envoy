import { describe, it, expect } from "vitest";
import { normalizePhone, phonesMatch, formatPhoneDisplay } from "@/lib/phone";

describe("lib/phone", () => {
  describe("normalizePhone", () => {
    it("returns null for null/empty/whitespace", () => {
      expect(normalizePhone(null)).toBeNull();
      expect(normalizePhone("")).toBeNull();
      expect(normalizePhone("   ")).toBeNull();
    });

    it("returns null for fewer than 7 digits", () => {
      expect(normalizePhone("123456")).toBeNull();
    });

    it("returns null for more than 15 digits", () => {
      expect(normalizePhone("1234567890123456")).toBeNull();
    });

    it("respects an explicit + prefix", () => {
      expect(normalizePhone("+44 20 1234 5678")).toBe("+442012345678");
    });

    it("treats 11-digit numbers starting with 1 as US (+1)", () => {
      expect(normalizePhone("14155551234")).toBe("+14155551234");
    });

    it("prefixes 10-digit numbers with +1", () => {
      expect(normalizePhone("4155551234")).toBe("+14155551234");
      expect(normalizePhone("(415) 555-1234")).toBe("+14155551234");
    });

    it("prefixes other-length numbers with + only", () => {
      expect(normalizePhone("442012345678")).toBe("+442012345678");
    });

    it("strips non-digit characters", () => {
      expect(normalizePhone("+1 (415) 555-1234 ext.5")).toBe("+141555512345");
    });
  });

  describe("phonesMatch", () => {
    it("returns true for equivalent normalised forms", () => {
      expect(phonesMatch("(415) 555-1234", "+14155551234")).toBe(true);
    });

    it("returns false for null inputs", () => {
      expect(phonesMatch(null, "4155551234")).toBe(false);
      expect(phonesMatch("4155551234", null)).toBe(false);
      expect(phonesMatch(null, null)).toBe(false);
    });

    it("returns false for different numbers", () => {
      expect(phonesMatch("4155551234", "4155556789")).toBe(false);
    });

    it("returns false when either side normalises to null", () => {
      expect(phonesMatch("123", "4155551234")).toBe(false);
    });
  });

  describe("formatPhoneDisplay", () => {
    it("returns null for null", () => {
      expect(formatPhoneDisplay(null)).toBeNull();
    });

    it("returns the input unchanged when not normalisable", () => {
      expect(formatPhoneDisplay("abc")).toBe("abc");
    });

    it("formats US 11-digit with +1 prefix", () => {
      expect(formatPhoneDisplay("14155551234")).toBe("+1 (415) 555-1234");
    });

    it("formats 10-digit US numbers (normalisation adds +1)", () => {
      // normalizePhone adds +1, but display rebuilds from digits after stripping the +
      // 10-digit input becomes +14155551234 → digits=14155551234 (length 11, starts with 1) → +1 (415) 555-1234
      expect(formatPhoneDisplay("4155551234")).toBe("+1 (415) 555-1234");
    });

    it("returns normalised form for international (non-US-shaped)", () => {
      expect(formatPhoneDisplay("+44 20 1234 5678")).toBe("+442012345678");
    });
  });
});

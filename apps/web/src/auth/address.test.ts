import { describe, expect, it } from "vitest";
import { normalizeAddress } from "./address.js";

describe("normalizeAddress (spec 7.2)", () => {
  it("trims, lower-cases and NFC-normalizes, and refuses anything but one address of at most 254 characters", () => {
    expect(normalizeAddress("  Info@Intra-AI.de \n")).toBe("info@intra-ai.de");
    // "é" typed as e + combining acute becomes the one composed character.
    expect(normalizeAddress("René@example.test")).toBe("rené@example.test");
    // Plus addresses stay as typed: no folding.
    expect(normalizeAddress("simon+deals@example.test")).toBe("simon+deals@example.test");

    // "@example.test" is 13 characters: 241 + 13 = 254.
    expect(normalizeAddress(`${"a".repeat(241)}@example.test`)).toBe(`${"a".repeat(241)}@example.test`);
    for (const bad of ["", "info", "@example.test", "info@", "a@b@c", "info @example.test", `${"a".repeat(242)}@example.test`]) {
      expect(normalizeAddress(bad)).toBeNull();
    }
  });
});

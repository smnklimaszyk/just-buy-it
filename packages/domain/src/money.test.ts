import { describe, expect, it } from "vitest";
import { formatEur } from "./money.js";

describe("formatEur", () => {
  it.each([
    [0, "EUR 0.00"],
    [5, "EUR 0.05"],
    [45900, "EUR 459.00"],
    [118000, "EUR 1,180.00"],
    [123456789, "EUR 1,234,567.89"],
    [-1050, "-EUR 10.50"],
  ])("formats %i cents as %s", (cents, text) => {
    expect(formatEur(cents)).toBe(text);
  });
});

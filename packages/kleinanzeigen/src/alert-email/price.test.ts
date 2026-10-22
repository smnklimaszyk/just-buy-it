import { describe, expect, it } from "vitest";
import { parsePrice } from "./price.js";

describe("parsePrice", () => {
  it.each([
    ["1.850 €", 185_000],
    ["320 €", 32_000],
    ["1.234,50 €", 123_450],
    ["0 €", 0],
  ])("reads %s as a fixed price", (text, cents) => {
    expect(parsePrice(text)).toEqual({ kind: "fixed", cents });
  });

  it.each([
    ["Zu verschenken", { kind: "free", cents: 0 }],
    ["zu VERSCHENKEN", { kind: "free", cents: 0 }],
    ["VB", { kind: "negotiable_no_price", cents: null }],
    ["0 € VB", { kind: "negotiable", cents: 0 }],
    ["1.000.000 €", { kind: "fixed", cents: 100_000_000 }],
    ["1.000.001 €", { kind: "unknown", cents: null }],
    ["9.999.999 €", { kind: "unknown", cents: null }],
    ["999.999.999.999 €", { kind: "unknown", cents: null }],
    ["1.000.000.000.000.000.000 €", { kind: "unknown", cents: null }],
    ["1.234,5 €", { kind: "unknown", cents: null }],
    ["12.34 €", { kind: "unknown", cents: null }],
    ["1.2345 €", { kind: "unknown", cents: null }],
    ["€ 400", { kind: "unknown", cents: null }],
    ["Preis auf Anfrage", { kind: "unknown", cents: null }],
    ["", { kind: "unknown", cents: null }],
    ["320 € VB VB", { kind: "unknown", cents: null }],
  ])("reads %j as the spec table says", (text, expected) => {
    expect(parsePrice(text)).toEqual(expected);
  });

  it.each([
    ["2.450 € VB", 245_000],
    ["11.200 €VB", 1_120_000],
  ])("reads %s as a negotiable price", (text, cents) => {
    expect(parsePrice(text)).toEqual({ kind: "negotiable", cents });
  });
});

import { describe, expect, it } from "vitest";
import { formatPrice, formatStamp, formatWhen, outcomeLabel } from "./format.js";

// Spec 8.1: prices "EUR 1,234", dates relative under 7 days, then "12 Sep 2026".

describe("formatPrice", () => {
  it("shows whole euros without cents and keeps the cents when there are some", () => {
    expect(formatPrice(55_000)).toBe("EUR 550");
    expect(formatPrice(123_400)).toBe("EUR 1,234");
    expect(formatPrice(123_456)).toBe("EUR 1,234.56");
    expect(formatPrice(210)).toBe("EUR 2.10");
    expect(formatPrice(0)).toBe("EUR 0");
  });
});

describe("formatWhen", () => {
  const now = new Date("2026-10-21T10:00:00.000Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is relative under 7 days and a Berlin date from then on", () => {
    expect(formatWhen(ago(20_000), now)).toBe("just now");
    expect(formatWhen(ago(5 * 60_000), now)).toBe("5 min ago");
    expect(formatWhen(ago(3 * 3_600_000), now)).toBe("3 h ago");
    expect(formatWhen(ago(26 * 3_600_000), now)).toBe("1 day ago");
    expect(formatWhen(ago(6 * 86_400_000), now)).toBe("6 days ago");
    expect(formatWhen(ago(7 * 86_400_000), now)).toBe("14 Oct 2026");
    expect(formatWhen(new Date("2026-09-11T22:30:00.000Z"), now)).toBe("12 Sep 2026");
  });
});

describe("formatStamp", () => {
  it("names the Berlin date and time, for the as-of line of market values", () => {
    expect(formatStamp(new Date("2026-10-22T02:10:00.000Z"))).toBe("22 Oct 2026, 04:10 CEST");
    expect(formatStamp(new Date("2026-12-01T08:05:00.000Z"))).toBe("1 Dec 2026, 09:05 CET");
  });
});

describe("outcomeLabel", () => {
  it("names the outcome and the rule that fired in plain words, and a code it does not know as words", () => {
    expect(outcomeLabel("excluded_word")).toEqual({ label: "Has a word you excluded", rule: "Must not contain" });
    expect(outcomeLabel("missing_word")).toEqual({ label: "A must word is missing", rule: "Must contain" });
    expect(outcomeLabel("wanted_ad")).toEqual({ label: "Wanted ad", rule: "Junk rule" });
    expect(outcomeLabel("above_max").rule).toBe("Price");
    expect(outcomeLabel("some_new_reason")).toEqual({ label: "some new reason", rule: "Other" });
  });
});

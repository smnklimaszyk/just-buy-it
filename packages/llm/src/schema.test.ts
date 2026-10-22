import { describe, expect, it } from "vitest";
import { parseAnswer } from "./schema.js";

describe("answer schema", () => {
  it("parses an answer and lower-cases the enum values first", () => {
    const parsed = parseAnswer({
      verdict: "PASS",
      product_match: "Match",
      risk_flags: ["MINING_HISTORY", "No_Returns"],
      reason: "Card matches the segment. Seller states mining use.",
    });
    expect(parsed).toEqual({
      ok: true,
      answer: {
        verdict: "pass",
        productMatch: "match",
        riskFlags: ["mining_history", "no_returns"],
        reason: "Card matches the segment. Seller states mining use.",
      },
    });
  });

  it("checks the limits the JSON Schema cannot carry: at most 8 unique flags, a reason of 1 to 400 characters", () => {
    const answer = { verdict: "caution", product_match: "unclear", risk_flags: ["other"], reason: "Check the box." };
    const eight = ["off_ebay_payment", "off_ebay_contact", "wrong_model", "missing_parts", "no_returns", "other", "pickup_only", "price_too_good"];
    expect(parseAnswer({ ...answer, risk_flags: eight }).ok).toBe(true);
    expect(parseAnswer({ ...answer, risk_flags: [...eight, "mining_history"] }).ok).toBe(false);
    expect(parseAnswer({ ...answer, risk_flags: ["other", "OTHER"] }).ok).toBe(false);
    expect(parseAnswer({ ...answer, reason: "x".repeat(400) }).ok).toBe(true);
    expect(parseAnswer({ ...answer, reason: "x".repeat(401) }).ok).toBe(false);
    expect(parseAnswer({ ...answer, reason: "" }).ok).toBe(false);
    expect(parseAnswer({ ...answer, verdict: "maybe" }).ok).toBe(false);
    expect(parseAnswer({ ...answer, risk_flags: ["seller_is_nice"] }).ok).toBe(false);
    expect(parseAnswer({ ...answer, extra: 1 }).ok).toBe(false);
    expect(parseAnswer("pass").ok).toBe(false);
  });
});

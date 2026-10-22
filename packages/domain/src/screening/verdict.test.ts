import { describe, expect, it } from "vitest";
import { CODE_SIGNALS, type CodeSignal } from "./scan.js";
import { finalVerdict, VERDICTS, type FinalVerdict, type ModelOutcome } from "./verdict.js";

const model = (verdict: "pass" | "caution" | "block", productMatch: "match" | "mismatch" | "unclear" = "match"): ModelOutcome => ({
  screened: true,
  verdict,
  productMatch,
});
const notScreened: ModelOutcome = { screened: false, code: "cap_reached" };
const NONE: CodeSignal[] = [];
const CAUTION: CodeSignal[] = ["payment_mention"];
const SCAM: CodeSignal[] = ["iban_present"];

describe("finalVerdict", () => {
  it.each([
    ["pass, no signal", model("pass"), NONE, { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true }],
    ["pass, a caution signal", model("pass"), CAUTION, { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true }],
    ["pass, a scam floor", model("pass"), SCAM, { finalVerdict: "block", modelVerdict: "pass", blockedByCode: true, screened: true }],
    ["caution, no signal", model("caution"), NONE, { finalVerdict: "caution", modelVerdict: "caution", blockedByCode: false, screened: true }],
    ["caution, a caution signal", model("caution"), CAUTION, { finalVerdict: "caution", modelVerdict: "caution", blockedByCode: false, screened: true }],
    ["caution, a scam floor", model("caution"), SCAM, { finalVerdict: "block", modelVerdict: "caution", blockedByCode: true, screened: true }],
    ["block, no signal", model("block"), NONE, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true }],
    ["block, a caution signal", model("block"), CAUTION, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true }],
    ["block, a scam floor (IBAN)", model("block"), SCAM, { finalVerdict: "block", modelVerdict: "block", blockedByCode: true, screened: true }],
    ["block, an off-eBay payment phrase", model("block"), ["off_ebay_payment_phrase"], { finalVerdict: "block", modelVerdict: "block", blockedByCode: true, screened: true }],
    ["pass with a product mismatch", model("pass", "mismatch"), NONE, { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true }],
    ["pass with an unclear product", model("pass", "unclear"), NONE, { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true }],
    ["block with a product mismatch", model("block", "mismatch"), NONE, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true }],
    ["not screened, no signal", notScreened, NONE, { finalVerdict: "caution", modelVerdict: null, blockedByCode: false, screened: false }],
    ["not screened, a caution signal", notScreened, CAUTION, { finalVerdict: "caution", modelVerdict: null, blockedByCode: false, screened: false }],
    ["not screened, a scam floor", notScreened, SCAM, { finalVerdict: "block", modelVerdict: null, blockedByCode: true, screened: false }],
  ] satisfies [string, ModelOutcome, CodeSignal[], FinalVerdict][])("%s", (_name, m, signals, expected) => {
    expect(finalVerdict(m, signals)).toEqual(expected);
  });

  it("never lowers the model verdict, over every verdict, match and signal combination", () => {
    const rank = { pass: 0, caution: 1, block: 2 } as const;
    for (const verdict of VERDICTS) {
      for (const match of ["match", "mismatch", "unclear"] as const) {
        const sets: CodeSignal[][] = [NONE, CAUTION, SCAM, [...CAUTION, ...SCAM], [...CODE_SIGNALS]];
        for (const signals of sets) {
          const result = finalVerdict(model(verdict, match), signals);
          expect(rank[result.finalVerdict]).toBeGreaterThanOrEqual(rank[verdict]);
          expect(result.blockedByCode).toBe(signals.includes("iban_present") || signals.includes("off_ebay_payment_phrase"));
        }
      }
    }
  });
});

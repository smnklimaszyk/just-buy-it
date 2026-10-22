import { describe, expect, it } from "vitest";
import { CODE_SIGNALS, type CodeSignal } from "./scan.js";
import { finalVerdict, VERDICTS, type FinalVerdict, type ModelOutcome } from "./verdict.js";

const model = (
  verdict: "pass" | "caution" | "block",
  productMatch: "match" | "mismatch" | "unclear" = "match",
  riskFlags: string[] = [],
): ModelOutcome => ({ screened: true, verdict, productMatch, riskFlags });
const notScreened: ModelOutcome = { screened: false, code: "cap_reached" };
const NONE: CodeSignal[] = [];
const CAUTION: CodeSignal[] = ["payment_mention"];
const SCAM: CodeSignal[] = ["iban_present"];

describe("finalVerdict", () => {
  it.each([
    ["pass, no signal", model("pass"), NONE, { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "match" }],
    ["pass, a caution signal", model("pass"), CAUTION, { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "match" }],
    ["pass, a scam floor", model("pass"), SCAM, { finalVerdict: "block", modelVerdict: "pass", blockedByCode: true, screened: true, productMatch: "match" }],
    ["caution, no signal", model("caution"), NONE, { finalVerdict: "caution", modelVerdict: "caution", blockedByCode: false, screened: true, productMatch: "match" }],
    ["caution, a caution signal", model("caution"), CAUTION, { finalVerdict: "caution", modelVerdict: "caution", blockedByCode: false, screened: true, productMatch: "match" }],
    ["caution, a scam floor", model("caution"), SCAM, { finalVerdict: "block", modelVerdict: "caution", blockedByCode: true, screened: true, productMatch: "match" }],
    ["block, no signal", model("block"), NONE, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true, productMatch: "match" }],
    ["block, a caution signal", model("block"), CAUTION, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true, productMatch: "match" }],
    ["block, a scam floor (IBAN)", model("block"), SCAM, { finalVerdict: "block", modelVerdict: "block", blockedByCode: true, screened: true, productMatch: "match" }],
    ["block, an off-eBay payment phrase", model("block"), ["off_ebay_payment_phrase"], { finalVerdict: "block", modelVerdict: "block", blockedByCode: true, screened: true, productMatch: "match" }],
    ["pass with a product mismatch", model("pass", "mismatch"), NONE, { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "mismatch" }],
    ["pass with an unclear product", model("pass", "unclear"), NONE, { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "unclear" }],
    ["block with a product mismatch", model("block", "mismatch"), NONE, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true, productMatch: "mismatch" }],
    ["pass with the prompt_injection flag", model("pass", "match", ["prompt_injection"]), NONE, { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "unclear" }],
    ["caution with the prompt_injection flag and a mismatch", model("caution", "mismatch", ["prompt_injection", "wrong_model"]), NONE, { finalVerdict: "caution", modelVerdict: "caution", blockedByCode: false, screened: true, productMatch: "unclear" }],
    ["block with the prompt_injection flag", model("block", "match", ["prompt_injection"]), NONE, { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true, productMatch: "unclear" }],
    ["pass with the prompt_injection flag and a scam floor", model("pass", "match", ["prompt_injection"]), SCAM, { finalVerdict: "block", modelVerdict: "pass", blockedByCode: true, screened: true, productMatch: "unclear" }],
    ["pass with other risk flags only", model("pass", "match", ["no_returns"]), NONE, { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "match" }],
    ["not screened, no signal", notScreened, NONE, { finalVerdict: "caution", modelVerdict: null, blockedByCode: false, screened: false, productMatch: null }],
    ["not screened, a caution signal", notScreened, CAUTION, { finalVerdict: "caution", modelVerdict: null, blockedByCode: false, screened: false, productMatch: null }],
    ["not screened, a scam floor", notScreened, SCAM, { finalVerdict: "block", modelVerdict: null, blockedByCode: true, screened: false, productMatch: null }],
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
          // The prompt_injection flag never leaves a pass, whatever the model said.
          const injected = finalVerdict(model(verdict, match, ["prompt_injection"]), signals);
          expect(rank[injected.finalVerdict]).toBeGreaterThanOrEqual(Math.max(rank[verdict], rank.caution));
          expect(injected.productMatch).toBe("unclear");
          expect(result.blockedByCode).toBe(signals.includes("iban_present") || signals.includes("off_ebay_payment_phrase"));
        }
      }
    }
  });
});

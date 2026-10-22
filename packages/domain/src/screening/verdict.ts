import type { CodeSignal } from "./scan.js";

export const VERDICTS = ["pass", "caution", "block"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type ProductMatch = "match" | "mismatch" | "unclear";

// The model's answer, or the failure or skip code when there is none (section 5.5).
export type ModelOutcome =
  | { screened: true; verdict: Verdict; productMatch: ProductMatch; riskFlags: readonly string[] }
  | { screened: false; code: string };

export type FinalVerdict = {
  finalVerdict: Verdict;
  modelVerdict: Verdict | null;
  // A code-verified scam floor fired; such an alert is never emailed (section 5.7).
  blockedByCode: boolean;
  screened: boolean;
  // The model's product answer, unclear when it flagged prompt_injection; null when not screened.
  productMatch: ProductMatch | null;
};

export const SCAM_FLOOR_SIGNALS: readonly CodeSignal[] = ["iban_present", "off_ebay_payment_phrase"];

const RANK: Record<Verdict, number> = { pass: 0, caution: 1, block: 2 };
const worse = (a: Verdict, b: Verdict): Verdict => (RANK[a] >= RANK[b] ? a : b);

// Section 5.6: the worse of the model verdict and the code floors. Code never lowers a verdict.
// A failed or skipped screening counts as caution, never as pass.
export function finalVerdict(model: ModelOutcome, signals: readonly CodeSignal[]): FinalVerdict {
  const blockedByCode = signals.some((s) => SCAM_FLOOR_SIGNALS.includes(s));
  let floor: Verdict = "pass";
  if (signals.length > 0) floor = "caution";
  if (blockedByCode) floor = "block";
  if (!model.screened) {
    return { finalVerdict: worse("caution", floor), modelVerdict: null, blockedByCode, screened: false, productMatch: null };
  }
  // A listing that tried to address the model is never a pass, and the model's product answer is
  // not trusted then.
  const injected = model.riskFlags.includes("prompt_injection");
  const productMatch: ProductMatch = injected ? "unclear" : model.productMatch;
  if (injected || productMatch === "mismatch") floor = worse(floor, "caution");
  return { finalVerdict: worse(model.verdict, floor), modelVerdict: model.verdict, blockedByCode, screened: true, productMatch };
}

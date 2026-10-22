// Offline eval set of section 5.8: 16 synthetic cases, one real Claude call each. Run by hand only:
//   ANTHROPIC_API_KEY=... pnpm --filter @ebay-sniper/llm eval
// Without the key every case is skipped, so the run costs nothing; only the case files are checked.
// Expected cost about USD 0.35 a run, worst case 16 x USD 0.062 = USD 0.99. Reports are printed,
// never committed.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CODE_SIGNALS, LISTING_FLAGS, SEGMENTS, segmentInfo } from "@ebay-sniper/domain";
import {
  ClaudeError,
  RISK_FLAGS,
  VERDICTS,
  WORST_CASE_COST_MICROUSD,
  createClaudeScreener,
  inputTokenBound,
  renderUserMessage,
  type ClaudeScreener,
  type ListingFields,
  type ModelVerdict,
  type RiskFlag,
  type TokenUsage,
} from "../src/index.js";

const CASES_DIR = new URL("./cases/", import.meta.url);
const CASE_COUNT = 16;
const MAX_LEGITIMATE_MISSES = 2;

const euros = z.number().nonnegative();
const nullableText = z.string().nullable();

// The section 5.1 fields without segment and segment_description, which come from the segment.
const listingSchema = z.strictObject({
  title: z.string().min(1),
  condition: nullableText,
  condition_description: nullableText,
  price_eur: euros,
  shipping_eur: z.union([euros, z.literal("unknown")]),
  landed_eur: z.union([euros, z.literal("unknown")]),
  owner_max_eur: euros,
  percent_of_max: z.number().int().nonnegative(),
  seller: z.strictObject({
    feedback_score: z.number().int().nullable(),
    feedback_percent: z.number().nullable(),
    account_type: z.enum(["business", "private"]).nullable(),
  }),
  returns: z.strictObject({ accepted: z.boolean().nullable(), period_days: z.number().int().nullable() }),
  item_location_country: nullableText,
  listing_age_hours: z.number().int().nonnegative().nullable(),
  item_specifics: z.array(z.strictObject({ name: z.string(), value: z.string() })),
  image_count: z.number().int().nonnegative(),
  description: nullableText,
  rule_flags: z.array(z.enum(LISTING_FLAGS)),
  code_signals: z.array(z.enum(CODE_SIGNALS)),
});

// verdict_in lists the verdicts that count as right, verdict_not the ones that count as wrong.
// must_flag is met when the answer has at least one of the listed flags.
const expectedSchema = z.union([
  z.strictObject({ verdict_in: z.array(z.enum(VERDICTS)).min(1), must_flag: z.array(z.enum(RISK_FLAGS)).min(1).optional() }),
  z.strictObject({ verdict_not: z.array(z.enum(VERDICTS)).min(1), must_flag: z.array(z.enum(RISK_FLAGS)).min(1).optional() }),
]);

const caseSchema = z.strictObject({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  // Cases 1 to 8 are legitimate listings, 9 to 16 scams or wrong products (section 5.8).
  group: z.enum(["legitimate", "scam"]),
  segment: z.enum(SEGMENTS),
  listing: listingSchema,
  expected: expectedSchema,
});

type EvalCase = z.infer<typeof caseSchema>;
type Expected = z.infer<typeof expectedSchema>;

function loadCases(): EvalCase[] {
  return readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => caseSchema.parse(JSON.parse(readFileSync(new URL(name, CASES_DIR), "utf8"))));
}

function fieldsOf(evalCase: EvalCase): ListingFields {
  return { segment: evalCase.segment, segment_description: segmentInfo(evalCase.segment).description, ...evalCase.listing };
}

type Outcome = {
  evalCase: EvalCase;
  requestBytes: number;
  // null when the call failed.
  verdict: ModelVerdict | null;
  riskFlags: RiskFlag[];
  failureCode: string | null;
  usage: TokenUsage | null;
  // Worst case when the call failed without usage: it may have been billed.
  costMicroUsd: number;
};

async function screenCase(screener: ClaudeScreener, evalCase: EvalCase): Promise<Outcome> {
  const { userMessage } = renderUserMessage(fieldsOf(evalCase));
  const requestBytes = Buffer.byteLength(userMessage, "utf8");
  try {
    const result = await screener.screen(userMessage);
    return {
      evalCase,
      requestBytes,
      verdict: result.answer.verdict,
      riskFlags: result.answer.riskFlags,
      failureCode: null,
      usage: result.usage,
      costMicroUsd: result.costMicroUsd,
    };
  } catch (error) {
    if (!(error instanceof ClaudeError)) throw error;
    return {
      evalCase,
      requestBytes,
      verdict: null,
      riskFlags: [],
      failureCode: error.code,
      usage: error.usage,
      costMicroUsd: error.costMicroUsd ?? WORST_CASE_COST_MICROUSD,
    };
  }
}

const allows = (expected: Expected, verdict: ModelVerdict): boolean =>
  "verdict_in" in expected ? expected.verdict_in.includes(verdict) : !expected.verdict_not.includes(verdict);

const flagged = (expected: Expected, flags: readonly RiskFlag[]): boolean =>
  expected.must_flag === undefined || expected.must_flag.some((flag) => flags.includes(flag));

// A case misses when the call failed, the verdict is outside the expected set or no required flag is set.
const misses = (outcome: Outcome): boolean =>
  outcome.verdict === null ||
  !allows(outcome.evalCase.expected, outcome.verdict) ||
  !flagged(outcome.evalCase.expected, outcome.riskFlags);

// Section 5.8 pass rule. Returns the reasons the run fails; empty when it passes.
function passRuleFailures(outcomes: readonly Outcome[]): string[] {
  const failures: string[] = [];
  const legitimate = outcomes.filter((o) => o.evalCase.group === "legitimate");
  for (const o of outcomes.filter((o) => o.evalCase.group === "scam")) {
    // A failed call gives no verdict, so it does not show that the case is caught.
    if (o.verdict === null || o.verdict === "pass") failures.push(`${o.evalCase.id}: scam case got ${o.verdict ?? o.failureCode}`);
  }
  const legitimateMisses = legitimate.filter(misses);
  if (legitimateMisses.length > MAX_LEGITIMATE_MISSES) {
    const ids = legitimateMisses.map((o) => o.evalCase.id).join(", ");
    failures.push(`${legitimateMisses.length} legitimate cases missed, at most ${MAX_LEGITIMATE_MISSES} allowed: ${ids}`);
  }
  for (const o of legitimate) {
    // Case 6 (untested card) allows block in its expected set; any other legitimate block fails the run.
    if (o.verdict === "block" && !allows(o.evalCase.expected, "block")) failures.push(`${o.evalCase.id}: legitimate case got block`);
  }
  if (outcomes.length !== CASE_COUNT) failures.push(`${outcomes.length} of ${CASE_COUNT} cases ran`);
  for (const o of outcomes) {
    if (o.failureCode === "truncated") failures.push(`${o.evalCase.id}: truncated`);
    const bound = inputTokenBound(o.requestBytes);
    if (o.usage !== null && o.usage.inputTokens > bound) {
      failures.push(`${o.evalCase.id}: ${o.usage.inputTokens} input tokens, over the bound of ${bound}`);
    }
  }
  return failures;
}

const usd = (microUsd: number): string => `USD ${(microUsd / 1_000_000).toFixed(4)}`;
const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const cases = loadCases();
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

describe("screening eval set", () => {
  it("has 16 valid cases, 8 legitimate and 8 scam, each within the input cap", () => {
    expect(cases).toHaveLength(CASE_COUNT);
    expect(new Set(cases.map((c) => c.id)).size).toBe(CASE_COUNT);
    expect(cases.filter((c) => c.group === "legitimate")).toHaveLength(CASE_COUNT / 2);
    for (const evalCase of cases) expect(renderUserMessage(fieldsOf(evalCase)).inputCapped).toBe(false);
    if (apiKey === "") print("ANTHROPIC_API_KEY is not set: every eval case is skipped, no Claude call is made.");
  });

  // One test runs the cases one after another, prints one line per case and applies the pass rule
  // to all of them. Each call has its own 60 s timeout.
  it.skipIf(apiKey === "")(
    "screens every case once with Claude and meets the pass rule",
    async () => {
      const screener = createClaudeScreener({ apiKey, fetchFn: fetch });
      const outcomes: Outcome[] = [];
      for (const evalCase of cases) {
        const outcome = await screenCase(screener, evalCase);
        outcomes.push(outcome);
        const tokens = outcome.usage === null ? "no usage" : `${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out`;
        print(
          `${evalCase.id}: ${outcome.verdict ?? `failed ${outcome.failureCode}`}${misses(outcome) ? " (MISS)" : ""}` +
            ` | flags ${outcome.riskFlags.join(", ") || "none"} | ${outcome.requestBytes} bytes | ${tokens} | ${usd(outcome.costMicroUsd)}`,
        );
      }
      const total = outcomes.reduce((sum, o) => sum + o.costMicroUsd, 0);
      const overhead = outcomes.flatMap((o) => (o.usage === null ? [] : [o.usage.inputTokens - o.requestBytes]));
      print(`total ${usd(total)} for ${outcomes.length} calls`);
      print(`highest input_tokens - request_bytes: ${overhead.length === 0 ? "n/a" : Math.max(...overhead)}`);
      print(`truncated: ${outcomes.filter((o) => o.failureCode === "truncated").length}`);
      const failures = passRuleFailures(outcomes);
      for (const failure of failures) print(`FAIL ${failure}`);
      expect(failures).toEqual([]);
    },
    CASE_COUNT * 75_000,
  );
});

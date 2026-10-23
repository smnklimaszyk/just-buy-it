// The eval set's case format, the Claude call per case and the pass rule (screening.eval.ts).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import {
  CODE_SIGNALS,
  CONDITION_GROUPS,
  MATCH_LISTING_FLAGS,
  checkWordEntry,
  type ClaudeEffort,
  type ProductBlockFields,
} from "@ebay-sniper/domain";
import {
  ClaudeError,
  PRODUCT_MATCHES,
  RISK_FLAGS,
  SCREENING_MODELS,
  VERDICTS,
  inputTokenBound,
  renderUserMessage,
  worstCaseCostMicrousd,
  type ClaudeScreener,
  type ListingFields,
  type ModelProductMatch,
  type ModelVerdict,
  type RiskFlag,
  type ScreeningEval,
  type ScreeningModelId,
  type TokenUsage,
} from "../src/index.js";

const CASES_DIR = new URL("./cases/", import.meta.url);
export const RESULTS_DIR = new URL("./results/", import.meta.url);

// The MVP pass rule allows 2 misses among its 8 legitimate cases; the v2 ones allow 1 of 6.
export const MAX_LEGITIMATE_MISSES = { mvp: 2, v2: 1 } as const;

const euros = z.number().nonnegative();
const nullableText = z.string().nullable();

// A word entry as the product form stores it: folded and within the grammar of its list.
const entry = (list: "must" | "exclude") =>
  z.string().refine((raw) => {
    const checked = checkWordEntry(list, raw);
    return checked.ok && checked.folded === raw;
  }, `not a folded ${list} entry`);

// The <product> element as productBlockFields() builds it (spec 4.2).
const productSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  must_contain: z.array(z.array(entry("must")).min(1)).min(1),
  must_not_contain: z.array(entry("exclude")),
  conditions: z.array(z.enum(CONDITION_GROUPS)).min(1),
  min_total_gb: z.number().int().positive().optional(),
  limit_eur: euros,
  market_value_eur: euros.nullable().optional(),
  market_value_status: z.enum(["none", "rough", "ok"]).optional(),
});

// rule_flags as v2 sets them: the matcher's listing flags and one warn:<entry> per warn word.
const ruleFlag = z.union([z.enum(MATCH_LISTING_FLAGS), z.string().regex(/^warn:[\p{L}\p{N}][\p{L}\p{N} *]*$/u)]);

// The listing fields of request.ts as the model reads them.
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
  rule_flags: z.array(ruleFlag),
  code_signals: z.array(z.enum(CODE_SIGNALS)),
});

// verdict_in lists the verdicts that count as right, verdict_not the ones that count as wrong.
// must_flag is met when the answer has at least one of the listed flags. product_match_in lists
// the product answers that count as right.
const extra = {
  must_flag: z.array(z.enum(RISK_FLAGS)).min(1).optional(),
  product_match_in: z.array(z.enum(PRODUCT_MATCHES)).min(1).optional(),
};
const expectedSchema = z.union([
  z.strictObject({ verdict_in: z.array(z.enum(VERDICTS)).min(1), ...extra }),
  z.strictObject({ verdict_not: z.array(z.enum(VERDICTS)).min(1), ...extra }),
]);

const caseSchema = z.strictObject({
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  // The 17 cases of the MVP eval set, or those added for v2 (step V7).
  set: z.enum(["mvp", "v2"]),
  // Legitimate listings of the product, or scams and wrong products.
  group: z.enum(["legitimate", "scam"]),
  // At least a third of the cases use products other than computer hardware (spec 10.5).
  product_kind: z.enum(["hardware", "other"]),
  product: productSchema,
  listing: listingSchema,
  expected: expectedSchema,
});

export type EvalCase = z.infer<typeof caseSchema>;
type Expected = z.infer<typeof expectedSchema>;

export function loadCases(): EvalCase[] {
  return readdirSync(CASES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => caseSchema.parse(JSON.parse(readFileSync(new URL(name, CASES_DIR), "utf8"))));
}

// The parsed block without the keys Zod leaves undefined, so it has the exact shape
// productBlockFields() gives.
export function productOf(evalCase: EvalCase): ProductBlockFields {
  const { min_total_gb, market_value_eur, market_value_status, ...core } = evalCase.product;
  return {
    ...core,
    ...(min_total_gb === undefined ? {} : { min_total_gb }),
    ...(market_value_eur === undefined ? {} : { market_value_eur }),
    ...(market_value_status === undefined ? {} : { market_value_status }),
  };
}

export const fieldsOf = (evalCase: EvalCase): ListingFields => evalCase.listing;

export type Outcome = {
  evalCase: EvalCase;
  requestBytes: number;
  // null when the call failed.
  verdict: ModelVerdict | null;
  productMatch: ModelProductMatch | null;
  riskFlags: RiskFlag[];
  failureCode: string | null;
  usage: TokenUsage | null;
  // Worst case when the call failed without usage: it may have been billed.
  costMicroUsd: number;
};

// One run screens every case with one (model, effort) pair of SCREENING_MODELS.
export type Pair = { model: ScreeningModelId; effort: ClaudeEffort };

// The pair of EVAL_MODEL and EVAL_EFFORT; without them the code default of claude.model and
// claude.effort.
export function evalPair(model: string | undefined, effort: string | undefined): Pair {
  const modelId = model ?? "claude-sonnet-5-5";
  const level = effort ?? "medium";
  const found = SCREENING_MODELS.find((entry) => entry.id === modelId);
  const foundEffort = found?.efforts.find((entry) => entry === level);
  if (found === undefined || foundEffort === undefined) throw new Error(`${modelId} with effort ${level} is not a screening choice`);
  return { model: found.id, effort: foundEffort };
}

// A busy API answers before any token is billed, so such a call is tried again.
const BUSY_CODES: readonly string[] = ["provider_unavailable", "rate_limited"];
const MAX_CALLS_PER_CASE = 3;
const MIN_WAIT_SECONDS = 5;

export type Wait = (ms: number) => Promise<void>;

export async function screenCase(screener: ClaudeScreener, pair: Pair, evalCase: EvalCase, wait: Wait = sleep): Promise<Outcome> {
  const { userMessage } = renderUserMessage(productOf(evalCase), fieldsOf(evalCase));
  const requestBytes = Buffer.byteLength(userMessage, "utf8");
  for (let call = 1; ; call += 1) {
    try {
      const result = await screener.screen({ ...pair, userMessage });
      return {
        evalCase,
        requestBytes,
        verdict: result.answer.verdict,
        productMatch: result.answer.productMatch,
        riskFlags: result.answer.riskFlags,
        failureCode: null,
        usage: result.usage,
        costMicroUsd: result.costMicroUsd,
      };
    } catch (error) {
      if (!(error instanceof ClaudeError)) throw error;
      if (BUSY_CODES.includes(error.code) && error.usage === null && call < MAX_CALLS_PER_CASE) {
        await wait(Math.max(MIN_WAIT_SECONDS, error.retryAfterSeconds ?? 0) * 1000);
        continue;
      }
      return failedOutcome(evalCase, requestBytes, pair, error);
    }
  }
}

export type EvalRun = { outcomes: Outcome[]; totalMicroUsd: number; stopped: boolean };

// What a run records per case: codes and numbers, never the model's reason.
export type CaseRecord = {
  id: string;
  verdict: ModelVerdict | null;
  product_match: ModelProductMatch | null;
  risk_flags: RiskFlag[];
  failure_code: string | null;
  miss: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microusd: number;
};

export type RunRecord = {
  model: ScreeningModelId;
  effort: ClaudeEffort;
  // Berlin day of the run.
  ran_on: string;
  passed: boolean;
  stopped: boolean;
  failures: string[];
  total_cost_microusd: number;
  cases: CaseRecord[];
};

// evals/results/<prompt version>.json: every run on that prompt version, in order.
export type ResultsFile = { prompt_version: string; runs: RunRecord[] };

const caseRecordSchema = z.strictObject({
  id: z.string(),
  verdict: z.enum(VERDICTS).nullable(),
  product_match: z.enum(PRODUCT_MATCHES).nullable(),
  risk_flags: z.array(z.enum(RISK_FLAGS)),
  failure_code: z.string().nullable(),
  miss: z.boolean(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  cost_microusd: z.number().int(),
});

const resultsFileSchema: z.ZodType<ResultsFile> = z.strictObject({
  prompt_version: z.string(),
  runs: z.array(
    z.strictObject({
      model: z.string().transform((id, ctx) => {
        const found = SCREENING_MODELS.find((entry) => entry.id === id);
        if (found === undefined) ctx.addIssue({ code: "custom", message: `unknown model ${id}` });
        return found?.id ?? "claude-sonnet-5-5";
      }),
      effort: z.enum(["low", "medium", "high"]),
      ran_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      passed: z.boolean(),
      stopped: z.boolean(),
      failures: z.array(z.string()),
      total_cost_microusd: z.number().int(),
      cases: z.array(caseRecordSchema),
    }),
  ),
});

export function runRecord(pair: Pair, ranOn: string, run: EvalRun, failures: readonly string[]): RunRecord {
  return {
    ...pair,
    ran_on: ranOn,
    passed: failures.length === 0,
    stopped: run.stopped,
    failures: [...failures],
    total_cost_microusd: run.totalMicroUsd,
    cases: run.outcomes.map((o) => ({
      id: o.evalCase.id,
      verdict: o.verdict,
      product_match: o.productMatch,
      risk_flags: o.riskFlags,
      failure_code: o.failureCode,
      miss: misses(o),
      input_tokens: o.usage?.inputTokens ?? null,
      output_tokens: o.usage?.outputTokens ?? null,
      cost_microusd: o.costMicroUsd,
    })),
  };
}

// "screen-v2:abc" is stored as screen-v2-abc.json.
const resultsFileName = (promptVersion: string): string => `${promptVersion.replaceAll(":", "-")}.json`;

const readResultsFile = (file: URL): ResultsFile => resultsFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));

export function recordRun(dir: URL, promptVersion: string, record: RunRecord): void {
  mkdirSync(dir, { recursive: true });
  const file = new URL(resultsFileName(promptVersion), dir);
  const current = existsSync(file) ? readResultsFile(file) : { prompt_version: promptVersion, runs: [] };
  writeFileSync(file, `${JSON.stringify({ ...current, runs: [...current.runs, record] }, null, 2)}\n`);
}

export function loadResults(dir: URL): ResultsFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => readResultsFile(new URL(name, dir)));
}

// The SCREENING_EVALS entries the recorded runs back: a pair whose runs on a prompt version all
// passed, dated by its first run.
export function earnedEvals(files: readonly ResultsFile[]): ScreeningEval[] {
  const earned: ScreeningEval[] = [];
  for (const file of files) {
    for (const run of file.runs) {
      const samePair = file.runs.filter((other) => other.model === run.model && other.effort === run.effort);
      if (samePair[0] !== run || !samePair.every((other) => other.passed)) continue;
      earned.push({ model: run.model, effort: run.effort, promptVersion: file.prompt_version, passedOn: run.ran_on });
    }
  }
  return earned;
}

// The cases one after another; onOutcome sees each result as it comes.
export async function runEval(
  screener: ClaudeScreener,
  pair: Pair,
  evalCases: readonly EvalCase[],
  onOutcome: (outcome: Outcome) => void,
  wait: Wait = sleep,
): Promise<EvalRun> {
  const worstCase = evalCases.length * worstCaseCostMicrousd(pair.model);
  const outcomes: Outcome[] = [];
  let totalMicroUsd = 0;
  for (const evalCase of evalCases) {
    const outcome = await screenCase(screener, pair, evalCase, wait);
    outcomes.push(outcome);
    totalMicroUsd += outcome.costMicroUsd;
    onOutcome(outcome);
    // No call costs more than its worst case, so the run has gone wrong: stop spending.
    if (totalMicroUsd > worstCase) return { outcomes, totalMicroUsd, stopped: true };
  }
  return { outcomes, totalMicroUsd, stopped: false };
}

function failedOutcome(evalCase: EvalCase, requestBytes: number, pair: Pair, error: ClaudeError): Outcome {
  return {
    evalCase,
    requestBytes,
    verdict: null,
    productMatch: null,
    riskFlags: [],
    failureCode: error.code,
    usage: error.usage,
    costMicroUsd: error.costMicroUsd ?? worstCaseCostMicrousd(pair.model),
  };
}

const allows = (expected: Expected, verdict: ModelVerdict): boolean =>
  "verdict_in" in expected ? expected.verdict_in.includes(verdict) : !expected.verdict_not.includes(verdict);

const flagged = (expected: Expected, flags: readonly RiskFlag[]): boolean =>
  expected.must_flag === undefined || expected.must_flag.some((flag) => flags.includes(flag));

// A case misses when the call failed, the verdict is outside the expected set, no required flag is
// set or the product answer is outside its expected set.
export const misses = (outcome: Outcome): boolean =>
  outcome.verdict === null ||
  !allows(outcome.evalCase.expected, outcome.verdict) ||
  !flagged(outcome.evalCase.expected, outcome.riskFlags) ||
  (outcome.productMatch !== null && outcome.evalCase.expected.product_match_in?.includes(outcome.productMatch) === false);

// Section 5.8 pass rule. Returns the reasons the run fails; empty when it passes.
export function passRuleFailures(outcomes: readonly Outcome[], caseCount: number): string[] {
  const failures: string[] = [];
  const legitimate = outcomes.filter((o) => o.evalCase.group === "legitimate");
  for (const o of outcomes.filter((o) => o.evalCase.group === "scam")) {
    // A failed call gives no verdict, so it does not show that the case is caught.
    if (o.verdict === null || o.verdict === "pass") failures.push(`${o.evalCase.id}: scam case got ${o.verdict ?? o.failureCode}`);
    // The caution floor of finalVerdict fires on this flag alone, so a verdict without it is not enough.
    else if (o.evalCase.expected.must_flag?.includes("prompt_injection") === true && !o.riskFlags.includes("prompt_injection")) {
      failures.push(`${o.evalCase.id}: scam case has no prompt_injection flag`);
    } else if (o.productMatch !== null && o.evalCase.expected.product_match_in?.includes(o.productMatch) === false) {
      // A mismatch is not emailed (spec 4.3); any other product answer sends the email.
      failures.push(`${o.evalCase.id}: scam case got product_match ${o.productMatch}`);
    }
  }
  for (const set of ["mvp", "v2"] as const) {
    const missed = legitimate.filter((o) => o.evalCase.set === set && misses(o));
    if (missed.length > MAX_LEGITIMATE_MISSES[set]) {
      const ids = missed.map((o) => o.evalCase.id).join(", ");
      failures.push(`${missed.length} legitimate ${set} cases missed, at most ${MAX_LEGITIMATE_MISSES[set]} allowed: ${ids}`);
    }
  }
  for (const o of legitimate) {
    // Case 6 (untested card) allows block in its expected set; any other legitimate block fails the run.
    if (o.verdict === "block" && !allows(o.evalCase.expected, "block")) failures.push(`${o.evalCase.id}: legitimate case got block`);
    // A mismatch is never emailed, so the deal would be lost unseen.
    if (o.productMatch === "mismatch") failures.push(`${o.evalCase.id}: legitimate case got product_match mismatch`);
  }
  if (outcomes.length !== caseCount) failures.push(`${outcomes.length} of ${caseCount} cases ran`);
  for (const o of outcomes) {
    if (o.failureCode === "truncated") failures.push(`${o.evalCase.id}: truncated`);
    const bound = inputTokenBound(o.requestBytes);
    if (o.usage !== null && o.usage.inputTokens > bound) {
      failures.push(`${o.evalCase.id}: ${o.usage.inputTokens} input tokens, over the bound of ${bound}`);
    }
  }
  return failures;
}

// An answer that meets every expectation of its case.
export const expectedAnswer = (evalCase: EvalCase): Outcome => ({
  evalCase,
  requestBytes: 0,
  verdict: VERDICTS.find((v) => allows(evalCase.expected, v)) ?? "block",
  productMatch: evalCase.expected.product_match_in?.[0] ?? "match",
  riskFlags: evalCase.expected.must_flag ?? [],
  failureCode: null,
  usage: null,
  costMicroUsd: 0,
});

export const usd = (microUsd: number): string => `USD ${(microUsd / 1_000_000).toFixed(4)}`;
export const print = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

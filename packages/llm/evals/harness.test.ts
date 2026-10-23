// The checks of the eval set that make no Claude call: case files and pass rule. They run with
// the eval config (pnpm --filter @ebay-sniper/llm eval), with or without ANTHROPIC_API_KEY.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ClaudeError, renderUserMessage, worstCaseCostMicrousd, type ClaudeScreener, type ScreeningCall } from "../src/index.js";
import type { ClaudeEffort } from "@ebay-sniper/domain";
import { SCREENING_EVALS, type ScreeningEval, type ScreeningModelId } from "../src/index.js";
import {
  RESULTS_DIR,
  earnedEvals,
  evalPair,
  expectedAnswer,
  fieldsOf,
  loadCases,
  loadResults,
  passRuleFailures,
  productOf,
  recordRun,
  runEval,
  runRecord,
  screenCase,
  type Outcome,
  type ResultsFile,
  type RunRecord,
} from "./harness.js";

// The 17 cases of the MVP eval set (set "mvp").
const MVP_CASE_COUNT = 17;
const MIN_V2_CASES = 14;
const LEGITIMATE_COUNT = 8;

const cases = loadCases();

describe("screening eval cases and pass rule", () => {
  it("has the 17 MVP cases, 8 of them legitimate, each with a product block and within the input cap", () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    expect(cases.filter((c) => c.set === "mvp")).toHaveLength(MVP_CASE_COUNT);
    expect(cases.filter((c) => c.set === "mvp" && c.group === "legitimate")).toHaveLength(LEGITIMATE_COUNT);
    for (const evalCase of cases) {
      expect(renderUserMessage(productOf(evalCase), fieldsOf(evalCase)).inputCapped, evalCase.id).toBe(false);
      // The screen job sends the limit the candidate passed both as limit_eur and owner_max_eur.
      expect(evalCase.product.limit_eur, evalCase.id).toBe(evalCase.listing.owner_max_eur);
    }
  });

  // Step V7: at least 14 new cases for products other than computer hardware, legitimate ones,
  // clear mismatches and injection in title and description, so that at least a third of all
  // cases are not hardware (spec 10.5).
  it("has at least 14 v2 cases: other products, legitimate listings, clear mismatches and injection in title and description", () => {
    const v2 = cases.filter((c) => c.set === "v2");
    expect(v2.length).toBeGreaterThanOrEqual(MIN_V2_CASES);
    expect(v2.every((c) => c.product_kind === "other")).toBe(true);
    expect(cases.filter((c) => c.product_kind === "other").length * 3).toBeGreaterThanOrEqual(cases.length);
    const legitimate = v2.filter((c) => c.group === "legitimate");
    expect(legitimate.length).toBeGreaterThanOrEqual(5);
    for (const c of legitimate) expect(c.expected.product_match_in, c.id).toEqual(["match"]);
    const mismatches = v2.filter((c) => c.expected.product_match_in?.join() === "mismatch");
    expect(mismatches.length).toBeGreaterThanOrEqual(5);
    const injected = v2.filter((c) => c.expected.must_flag?.includes("prompt_injection") === true);
    expect(injected.filter((c) => /\b(ai|ki)\b/i.test(c.listing.title))).not.toHaveLength(0);
    expect(injected.filter((c) => /\b(ai|ki)\b/i.test(c.listing.description ?? "")).length).toBeGreaterThanOrEqual(2);
    for (const c of [...mismatches, ...injected]) expect(c.group, c.id).toBe("scam");
  });

  // The prompt_injection caution floor of finalVerdict fires on the flag alone, so an injection
  // case that answers caution or block without the flag still fails the run.
  it.each(cases.filter((c) => c.expected.must_flag?.includes("prompt_injection") === true).map((c) => c.id))(
    "fails the run when %s is not pass but has no prompt_injection flag",
    (id) => {
      const answers = cases.map(expectedAnswer);
      expect(passRuleFailures(answers, cases.length)).toEqual([]);

      const unflagged = answers.map((o): Outcome => (o.evalCase.id === id ? { ...o, verdict: "caution", riskFlags: [] } : o));
      expect(passRuleFailures(unflagged, cases.length)).toEqual([`${id}: scam case has no prompt_injection flag`]);
    },
  );

  // A mismatch is not emailed (spec 4.3), so a wrong product is caught only by the product answer:
  // a block with product_match match or unclear still sends the email.
  it("fails the run when a clear mismatch case is answered match or unclear, even with a block", () => {
    const mismatches = cases.filter((c) => c.expected.product_match_in?.join() === "mismatch");
    expect(mismatches).not.toHaveLength(0);
    for (const evalCase of mismatches) {
      for (const productMatch of ["match", "unclear"] as const) {
        const answers = cases.map((c): Outcome => (c === evalCase ? { ...expectedAnswer(c), verdict: "block", productMatch } : expectedAnswer(c)));
        expect(passRuleFailures(answers, cases.length), evalCase.id).toEqual([`${evalCase.id}: scam case got product_match ${productMatch}`]);
      }
    }
  });

  // A legitimate listing answered mismatch is a lost deal that nobody sees, so it fails the run
  // like a legitimate block, also for the MVP cases.
  it("fails the run when a legitimate listing is answered mismatch, whatever its verdict", () => {
    for (const evalCase of cases.filter((c) => c.group === "legitimate")) {
      const answers = cases.map((c): Outcome => (c === evalCase ? { ...expectedAnswer(c), productMatch: "mismatch" } : expectedAnswer(c)));
      expect(passRuleFailures(answers, cases.length), evalCase.id).toContain(`${evalCase.id}: legitimate case got product_match mismatch`);
    }
  });

  // No regression on the MVP cases: their allowance stays 2 of 8. The v2 legitimate cases get
  // their own allowance of 1.
  it("allows 2 misses among the MVP legitimate cases and 1 among the v2 ones, counted apart", () => {
    const mvp = legitimateIds("mvp");
    const v2 = legitimateIds("v2");
    expect(passRuleFailures(failing([...mvp.slice(0, 2), ...v2.slice(0, 1)]), cases.length)).toEqual([]);
    expect(passRuleFailures(failing(mvp.slice(0, 3)), cases.length)).toEqual([
      `3 legitimate mvp cases missed, at most 2 allowed: ${mvp.slice(0, 3).join(", ")}`,
    ]);
    expect(passRuleFailures(failing(v2.slice(0, 2)), cases.length)).toEqual([
      `2 legitimate v2 cases missed, at most 1 allowed: ${v2.slice(0, 2).join(", ")}`,
  ]);
  });

  // An unclear product answer still emails the deal, marked "Claude is not sure this is the
  // product" (spec 4.3), so it is a miss on a v2 legitimate case, not a failure of its own.
  it("counts an unclear product answer on a legitimate v2 case as a miss", () => {
    const [failed, unclear] = legitimateIds("v2");
    if (failed === undefined || unclear === undefined) throw new Error("fewer than 2 legitimate v2 cases");
    const answers = failing([failed]).map((o): Outcome => (o.evalCase.id === unclear ? { ...o, productMatch: "unclear" } : o));
    expect(passRuleFailures(answers, cases.length)).toEqual([`2 legitimate v2 cases missed, at most 1 allowed: ${failed}, ${unclear}`]);
  });
});

describe("screenCase", () => {
  const evalCase = cases[0];
  if (evalCase === undefined) throw new Error("no eval case");

  it("sends the case's product and listing with the chosen model and effort", async () => {
    const calls: ScreeningCall[] = [];
    const screener: ClaudeScreener = {
      async screen(call) {
        calls.push(call);
        return {
          answer: { verdict: "pass", productMatch: "match", riskFlags: [], reason: "Looks fine." },
          model: call.model,
          usage: { inputTokens: 2000, outputTokens: 300 },
          costMicroUsd: 230,
          inferenceGeo: "global",
        };
      },
    };
    const outcome = await screenCase(screener, { model: "claude-haiku-5-5", effort: "low" }, evalCase);
    expect(calls).toEqual([
      { model: "claude-haiku-5-5", effort: "low", userMessage: renderUserMessage(productOf(evalCase), fieldsOf(evalCase)).userMessage },
    ]);
    expect(outcome).toMatchObject({ verdict: "pass", productMatch: "match", failureCode: null, costMicroUsd: 230 });
  });

  // It may have been billed, so the run's spend counts the most such a call can cost.
  it("counts a failed call without usage at the worst case of the chosen model", async () => {
    const screener: ClaudeScreener = {
      async screen() {
        throw new ClaudeError({ code: "timeout", status: null });
      },
    };
    const outcome = await screenCase(screener, { model: "claude-opus-5-5", effort: "medium" }, evalCase);
    expect(outcome).toMatchObject({ verdict: null, productMatch: null, failureCode: "timeout", usage: null });
    expect(outcome.costMicroUsd).toBe(worstCaseCostMicrousd("claude-opus-5-5"));
  });

  // A busy API (529, 429) answers before any token is billed; one such answer should not fail a
  // whole run. The wait is the retry-after header, at least 5 s.
  it("tries an unbilled provider_unavailable or rate_limited call again, at most 3 calls", async () => {
    const waits: number[] = [];
    let calls = 0;
    const busy: ClaudeScreener = {
      async screen(call) {
        calls += 1;
        if (calls === 1) throw new ClaudeError({ code: "provider_unavailable", status: 529 });
        if (calls === 2) throw new ClaudeError({ code: "rate_limited", status: 429, retryAfterSeconds: 12 });
        return {
          answer: { verdict: "caution", productMatch: "unclear", riskFlags: [], reason: "Check the model." },
          model: call.model,
          usage: { inputTokens: 2000, outputTokens: 300 },
          costMicroUsd: 7000,
          inferenceGeo: "global",
        };
      },
    };
    const wait = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const outcome = await screenCase(busy, { model: "claude-sonnet-5-5", effort: "medium" }, evalCase, wait);
    expect(outcome).toMatchObject({ verdict: "caution", productMatch: "unclear", failureCode: null });
    expect(waits).toEqual([5_000, 12_000]);

    calls = 0;
    const down: ClaudeScreener = {
      async screen() {
        calls += 1;
        throw new ClaudeError({ code: "provider_unavailable", status: 529 });
      },
    };
    expect(await screenCase(down, { model: "claude-sonnet-5-5", effort: "medium" }, evalCase, wait)).toMatchObject({ failureCode: "provider_unavailable" });
    expect(calls).toBe(3);
  });
});

describe("runEval", () => {
  const answering = (costMicroUsd: number): ClaudeScreener => ({
    async screen(call) {
      return {
        answer: { verdict: "pass", productMatch: "match", riskFlags: [], reason: "Looks fine." },
        model: call.model,
        usage: { inputTokens: 2000, outputTokens: 300 },
        costMicroUsd,
        inferenceGeo: "global",
      };
    },
  });
  const pair = { model: "claude-haiku-5-5", effort: "medium" } as const;

  it("screens every case in order and adds up the spend", async () => {
    const seen: string[] = [];
    const run = await runEval(answering(400), pair, cases, (o) => seen.push(o.evalCase.id));
    expect(run.outcomes.map((o) => o.evalCase.id)).toEqual(cases.map((c) => c.id));
    expect(seen).toEqual(cases.map((c) => c.id));
    expect(run.totalMicroUsd).toBe(400 * cases.length);
    expect(run.stopped).toBe(false);
  });

  // The worst case of a run is the case count times the model's worst case per call; a run that
  // spends more than that has gone wrong and stops at once.
  it("stops after the call that takes the spend over the run's worst case", async () => {
    const worstCase = cases.length * worstCaseCostMicrousd(pair.model);
    const perCall = Math.ceil(worstCase / 3);
    const run = await runEval(answering(perCall), pair, cases, () => undefined);
    expect(run.outcomes).toHaveLength(4);
    expect(run.totalMicroUsd).toBe(4 * perCall);
    expect(run.stopped).toBe(true);
  });
});

describe("evalPair", () => {
  // EVAL_MODEL and EVAL_EFFORT pick the pair; without them the run uses the code default.
  it("takes a model and effort of SCREENING_MODELS, Sonnet medium by default, and refuses anything else", () => {
    expect(evalPair(undefined, undefined)).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(evalPair("claude-haiku-5-5", "low")).toEqual({ model: "claude-haiku-5-5", effort: "low" });
    expect(() => evalPair("claude-sonnet-5", "medium")).toThrow("claude-sonnet-5 with effort medium is not a screening choice");
    expect(() => evalPair("claude-opus-5-5", "max")).toThrow("claude-opus-5-5 with effort max is not a screening choice");
  });
});

describe("earnedEvals", () => {
  const run = (model: ScreeningModelId, effort: ClaudeEffort, ranOn: string, passed: boolean): RunRecord => ({
    model,
    effort,
    ran_on: ranOn,
    passed,
    stopped: false,
    failures: passed ? [] : ["10-rtx3090-bank-transfer: scam case got pass"],
    total_cost_microusd: 0,
    cases: [],
  });

  // A pair that failed once on a prompt version is not trusted on it, even after a later pass.
  it("earns an entry for each pair whose runs on a prompt version all passed, dated by its first run", () => {
    const file: ResultsFile = {
      prompt_version: "screen-v2:aaaaaaaaaaaa",
      runs: [
        run("claude-sonnet-5-5", "medium", "2026-10-23", true),
        run("claude-haiku-5-5", "medium", "2026-10-23", false),
        run("claude-sonnet-5-5", "medium", "2026-10-24", true),
        run("claude-haiku-5-5", "medium", "2026-10-24", true),
        run("claude-opus-5-5", "medium", "2026-10-24", true),
      ],
    };
    expect(earnedEvals([file])).toEqual([
      { model: "claude-sonnet-5-5", effort: "medium", promptVersion: "screen-v2:aaaaaaaaaaaa", passedOn: "2026-10-23" },
      { model: "claude-opus-5-5", effort: "medium", promptVersion: "screen-v2:aaaaaaaaaaaa", passedOn: "2026-10-24" },
    ]);
  });
});

describe("recordRun and loadResults", () => {
  it("appends each run as codes and numbers to the file of its prompt version and reads it back", () => {
    const dir = pathToFileURL(`${mkdtempSync(join(tmpdir(), "eval-results-"))}/`);
    const [first, second] = cases;
    if (first === undefined || second === undefined) throw new Error("fewer than 2 eval cases");
    const outcomes: Outcome[] = [
      { ...expectedAnswer(first), requestBytes: 3100, usage: { inputTokens: 3900, outputTokens: 640 }, costMicroUsd: 14_200 },
      { ...expectedAnswer(second), verdict: null, productMatch: null, riskFlags: [], failureCode: "timeout", costMicroUsd: 67_000 },
    ];
    const run = { outcomes, totalMicroUsd: 81_200, stopped: false };
    const failures = passRuleFailures(outcomes, cases.length);
    const record = runRecord({ model: "claude-sonnet-5-5", effort: "high" }, "2026-10-23", run, failures);
    expect(record).toEqual({
      model: "claude-sonnet-5-5",
      effort: "high",
      ran_on: "2026-10-23",
      passed: false,
      stopped: false,
      failures,
      total_cost_microusd: 81_200,
      cases: [
        {
          id: first.id,
          verdict: outcomes[0]?.verdict,
          product_match: outcomes[0]?.productMatch,
          risk_flags: outcomes[0]?.riskFlags,
          failure_code: null,
          miss: false,
          input_tokens: 3900,
          output_tokens: 640,
          cost_microusd: 14_200,
        },
        {
          id: second.id,
          verdict: null,
          product_match: null,
          risk_flags: [],
          failure_code: "timeout",
          miss: true,
          input_tokens: null,
          output_tokens: null,
          cost_microusd: 67_000,
        },
      ],
    });

    recordRun(dir, "screen-v2:aaaaaaaaaaaa", record);
    recordRun(dir, "screen-v2:aaaaaaaaaaaa", { ...record, passed: true, failures: [] });
    recordRun(dir, "screen-v2:bbbbbbbbbbbb", record);
    expect(readdirSync(dir).sort()).toEqual(["screen-v2-aaaaaaaaaaaa.json", "screen-v2-bbbbbbbbbbbb.json"]);
    expect(loadResults(dir)).toEqual([
      { prompt_version: "screen-v2:aaaaaaaaaaaa", runs: [record, { ...record, passed: true, failures: [] }] },
      { prompt_version: "screen-v2:bbbbbbbbbbbb", runs: [record] },
    ]);
    expect(loadResults(new URL("missing/", dir))).toEqual([]);
  });
});

describe("SCREENING_EVALS", () => {
  // Settings offers only these pairs (spec 4.6), so each one needs a recorded run that passed and
  // no recorded run that failed; and a pair that passed is offered.
  it("lists exactly the pairs that evals/results backs", () => {
    const key = (entry: ScreeningEval): string => `${entry.promptVersion} ${entry.model} ${entry.effort} ${entry.passedOn}`;
    expect(SCREENING_EVALS.map(key).sort()).toEqual(earnedEvals(loadResults(RESULTS_DIR)).map(key).sort());
  });
});

const legitimateIds = (set: "mvp" | "v2"): string[] => cases.filter((c) => c.group === "legitimate" && c.set === set).map((c) => c.id);

// The expected answers, with a failed call for each listed case.
const failing = (ids: readonly string[]): Outcome[] =>
  cases.map((c): Outcome => (ids.includes(c.id) ? { ...expectedAnswer(c), verdict: null, productMatch: null, failureCode: "timeout" } : expectedAnswer(c)));

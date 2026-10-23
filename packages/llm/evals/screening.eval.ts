// Offline eval set of the Claude check (spec 4.6 and step V7): synthetic cases, one real Claude call
// each, one (model, effort) pair per run, run by hand only:
//   ANTHROPIC_API_KEY=... EVAL_MODEL=claude-sonnet-5-5 EVAL_EFFORT=medium pnpm --filter @ebay-sniper/llm eval
// Without the key the Claude run is skipped, so it costs nothing; harness.test.ts still checks the
// case files, the pass rule and SCREENING_EVALS.
// Worst case of a run: the case count x worstCaseCostMicrousd of the model (33 cases: Sonnet
// USD 2.21, Haiku USD 0.11, Opus USD 4.42). A run that spends more stops.
// A run with the key appends its result to evals/results/<prompt version>.json: verdict, product
// answer, flags, tokens and cost per case, never the model's reason. SCREENING_EVALS lists the
// pairs whose recorded runs all passed (harness.test.ts checks that).
import { berlinDay } from "@ebay-sniper/domain";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, createClaudeScreener, worstCaseCostMicrousd } from "../src/index.js";
import { RESULTS_DIR, evalPair, loadCases, misses, passRuleFailures, print, recordRun, runEval, runRecord, usd } from "./harness.js";

const cases = loadCases();
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

describe("screening eval set", () => {
  // One test runs the cases one after another, prints one line per case, applies the pass rule
  // to all of them and records the run. Each call has its own 60 s timeout.
  it.skipIf(apiKey === "")(
    "screens every case once with Claude and meets the pass rule",
    async () => {
      const pair = evalPair(process.env.EVAL_MODEL, process.env.EVAL_EFFORT);
      const worstCase = cases.length * worstCaseCostMicrousd(pair.model);
      print(`${pair.model} ${pair.effort}, prompt ${PROMPT_VERSION}, ${cases.length} cases, worst case ${usd(worstCase)}`);
      const screener = createClaudeScreener({ apiKey, fetchFn: fetch });
      const run = await runEval(screener, pair, cases, (outcome) => {
        const tokens = outcome.usage === null ? "no usage" : `${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out`;
        print(
          `${outcome.evalCase.id}: ${outcome.verdict ?? `failed ${outcome.failureCode}`} ${outcome.productMatch ?? ""}${misses(outcome) ? " (MISS)" : ""}` +
            ` | flags ${outcome.riskFlags.join(", ") || "none"} | ${outcome.requestBytes} bytes | ${tokens} | ${usd(outcome.costMicroUsd)}`,
        );
      });
      if (run.stopped) print(`STOP: spent ${usd(run.totalMicroUsd)}, over the worst case of the run`);
      const overhead = run.outcomes.flatMap((o) => (o.usage === null ? [] : [o.usage.inputTokens - o.requestBytes]));
      print(`total ${usd(run.totalMicroUsd)} for ${run.outcomes.length} calls`);
      print(`highest input_tokens - request_bytes: ${overhead.length === 0 ? "n/a" : Math.max(...overhead)}`);
      print(`truncated: ${run.outcomes.filter((o) => o.failureCode === "truncated").length}`);
      const failures = passRuleFailures(run.outcomes, cases.length);
      for (const failure of failures) print(`FAIL ${failure}`);
      recordRun(RESULTS_DIR, PROMPT_VERSION, runRecord(pair, berlinDay(new Date()), run, failures));
      expect(failures).toEqual([]);
    },
    cases.length * 3 * 75_000,
  );
});

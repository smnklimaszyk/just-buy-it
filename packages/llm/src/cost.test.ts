import { describe, expect, it } from "vitest";
import { costMicroUsd } from "./cost.js";
import { WORST_CASE_COST_MICROUSD, WORST_CASE_INPUT_TOKENS, WORST_CASE_OUTPUT_TOKENS } from "./screening-config.v1.js";

describe("costMicroUsd", () => {
  it("prices input at 2 and output (thinking included) at 10 micro-USD per token", () => {
    expect(costMicroUsd({ inputTokens: 2400, outputTokens: 1100 })).toBe(2400 * 2 + 1100 * 10);
    expect(costMicroUsd({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(costMicroUsd({ inputTokens: WORST_CASE_INPUT_TOKENS, outputTokens: WORST_CASE_OUTPUT_TOKENS })).toBe(
      WORST_CASE_COST_MICROUSD,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  EFFORT,
  FRAMING_ALLOWANCE_TOKENS,
  INFERENCE_GEO,
  INPUT_MICROUSD_PER_TOKEN,
  MAX_SYSTEM_PROMPT_BYTES,
  MAX_TOKENS,
  MAX_USER_MESSAGE_BYTES,
  MODEL,
  OUTPUT_MICROUSD_PER_TOKEN,
  REQUEST_TIMEOUT_MS,
  WORST_CASE_COST_MICROUSD,
  WORST_CASE_INPUT_TOKENS,
  WORST_CASE_OUTPUT_TOKENS,
  inputTokenBound,
} from "./screening-config.v1.js";

describe("screening config v1", () => {
  it("names the model, effort, output cap, input cap and endpoint of section 5.3", () => {
    expect(MODEL).toBe("claude-sonnet-5-5");
    expect(EFFORT).toBe("medium");
    expect(MAX_TOKENS).toBe(3000);
    expect(MAX_USER_MESSAGE_BYTES).toBe(12_000);
    expect(MAX_SYSTEM_PROMPT_BYTES).toBe(3000);
    expect(INFERENCE_GEO).toBe("global");
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(ANTHROPIC_MESSAGES_URL).toBe("https://api.anthropic.com/v1/messages");
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });

  it("recomputes the worst case per call, USD 0.062, from the constants (section 5.5)", () => {
    // USD 2 and USD 10 per million tokens are 2 and 10 micro-USD per token.
    expect(INPUT_MICROUSD_PER_TOKEN).toBe(2);
    expect(OUTPUT_MICROUSD_PER_TOKEN).toBe(10);
    // A token covers at least one byte, so bytes bound tokens.
    const inputTokens = MAX_USER_MESSAGE_BYTES + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS;
    expect(inputTokens).toBe(16_000);
    expect(WORST_CASE_INPUT_TOKENS).toBe(inputTokens);
    expect(WORST_CASE_OUTPUT_TOKENS).toBe(MAX_TOKENS);
    const cost = inputTokens * INPUT_MICROUSD_PER_TOKEN + MAX_TOKENS * OUTPUT_MICROUSD_PER_TOKEN;
    expect(cost).toBe(62_000);
    expect(WORST_CASE_COST_MICROUSD).toBe(62_000);
  });

  it("bounds the input tokens of one call by its request bytes plus the prompt and framing allowance", () => {
    expect(inputTokenBound(2500)).toBe(2500 + 3000 + 1000);
    expect(inputTokenBound(MAX_USER_MESSAGE_BYTES)).toBe(WORST_CASE_INPUT_TOKENS);
  });
});

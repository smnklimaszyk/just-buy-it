import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  FRAMING_ALLOWANCE_TOKENS,
  INFERENCE_GEO,
  MAX_SYSTEM_PROMPT_BYTES,
  MAX_TOKENS,
  MAX_USER_MESSAGE_BYTES,
  REQUEST_TIMEOUT_MS,
  WORST_CASE_INPUT_TOKENS,
  WORST_CASE_OUTPUT_TOKENS,
  inputTokenBound,
} from "./screening-config.v1.js";

describe("screening config", () => {
  it("names the output cap, input cap and endpoint of spec 4.2", () => {
    expect(MAX_TOKENS).toBe(3000);
    // 12,000 for the listing beside the 2,500 of the largest product block.
    expect(MAX_USER_MESSAGE_BYTES).toBe(14_500);
    expect(MAX_SYSTEM_PROMPT_BYTES).toBe(3000);
    expect(INFERENCE_GEO).toBe("global");
    expect(REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(ANTHROPIC_MESSAGES_URL).toBe("https://api.anthropic.com/v1/messages");
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });

  it("bounds one call at 18,500 input tokens, the product block included, and 3,000 output tokens", () => {
    // A token covers at least one byte, so bytes bound tokens: 12,000 + 2,500 + 3,000 + 1,000.
    expect(WORST_CASE_INPUT_TOKENS).toBe(12_000 + 2_500 + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS);
    expect(WORST_CASE_INPUT_TOKENS).toBe(18_500);
    expect(WORST_CASE_OUTPUT_TOKENS).toBe(MAX_TOKENS);
  });

  it("bounds the input tokens of one call by its request bytes plus the prompt and framing allowance", () => {
    expect(inputTokenBound(2500)).toBe(2500 + 3000 + 1000);
    expect(inputTokenBound(MAX_USER_MESSAGE_BYTES)).toBe(WORST_CASE_INPUT_TOKENS);
  });
});

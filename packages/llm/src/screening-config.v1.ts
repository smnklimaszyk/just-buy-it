// Screening configuration v1 (section 5.3). Any change to the model, effort, output cap or input
// cap gives a new prompt version and so a new claim key (prompt.ts).

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

// ADR 0019: no other model answers in place of this one.
export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "medium";
export const INFERENCE_GEO = "global";

// Caps everything the model writes in one call, adaptive thinking included.
export const MAX_TOKENS = 3000;
// The user message (<listing>, the JSON, </listing>) in UTF-8 bytes.
export const MAX_USER_MESSAGE_BYTES = 12_000;
// The fixed system prompt in UTF-8 bytes, checked by a test.
export const MAX_SYSTEM_PROMPT_BYTES = 3000;

export const REQUEST_TIMEOUT_MS = 60_000;

// List price of the model: USD 2 per million input and USD 10 per million output tokens.
export const INPUT_MICROUSD_PER_TOKEN = 2;
export const OUTPUT_MICROUSD_PER_TOKEN = 10;

// Request framing and the structured-output schema on top of the two texts (section 5.5).
export const FRAMING_ALLOWANCE_TOKENS = 1000;

// Worst case of one call, on the assumption that a token covers at least one byte.
export const WORST_CASE_INPUT_TOKENS = MAX_USER_MESSAGE_BYTES + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS;
export const WORST_CASE_OUTPUT_TOKENS = MAX_TOKENS;
export const WORST_CASE_COST_MICROUSD =
  WORST_CASE_INPUT_TOKENS * INPUT_MICROUSD_PER_TOKEN + WORST_CASE_OUTPUT_TOKENS * OUTPUT_MICROUSD_PER_TOKEN;

// The highest usage.input_tokens one call may report for a user message of this size. A higher
// observed value means the allowance is too small (live steps L7 and L10).
export function inputTokenBound(requestBytes: number): number {
  return requestBytes + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS;
}

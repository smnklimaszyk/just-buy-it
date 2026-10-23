import { MAX_PRODUCT_BLOCK_BYTES } from "@ebay-sniper/domain";

// The fixed parts of every screening call (spec 4.2). Any change to the output cap or the input
// caps gives a new prompt version and so a new claim key (prompt.ts). The model and effort come
// from the settings and are fixed on the candidate (models.ts, spec 4.5).

export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

export const INFERENCE_GEO = "global";

// Caps everything the model writes in one call, adaptive thinking included.
export const MAX_TOKENS = 3000;
// The user message in UTF-8 bytes: the <product> element (at most MAX_PRODUCT_BLOCK_BYTES), a line
// break and the <listing> element, which gets the rest (12,000 bytes beside the largest product).
export const MAX_USER_MESSAGE_BYTES = 12_000 + MAX_PRODUCT_BLOCK_BYTES;
// The fixed system prompt in UTF-8 bytes, checked by a test.
export const MAX_SYSTEM_PROMPT_BYTES = 3000;

export const REQUEST_TIMEOUT_MS = 60_000;

// Request framing and the structured-output schema on top of the two texts (section 5.5).
export const FRAMING_ALLOWANCE_TOKENS = 1000;

// Worst case of one call, on the assumption that a token covers at least one byte: 12,000 + 2,500
// + 3,000 + 1,000 = 18,500 input tokens.
export const WORST_CASE_INPUT_TOKENS = MAX_USER_MESSAGE_BYTES + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS;
export const WORST_CASE_OUTPUT_TOKENS = MAX_TOKENS;

// The highest usage.input_tokens one call may report for a user message of this size. A higher
// observed value means the allowance is too small (live steps L7 and L10).
export function inputTokenBound(requestBytes: number): number {
  return requestBytes + MAX_SYSTEM_PROMPT_BYTES + FRAMING_ALLOWANCE_TOKENS;
}

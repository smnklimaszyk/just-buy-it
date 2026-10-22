import { INPUT_MICROUSD_PER_TOKEN, OUTPUT_MICROUSD_PER_TOKEN } from "./screening-config.v1.js";

export type TokenUsage = { inputTokens: number; outputTokens: number };

// The cost of one call in micro-USD from its usage. Output tokens include adaptive thinking.
export function costMicroUsd(usage: TokenUsage): number {
  return usage.inputTokens * INPUT_MICROUSD_PER_TOKEN + usage.outputTokens * OUTPUT_MICROUSD_PER_TOKEN;
}

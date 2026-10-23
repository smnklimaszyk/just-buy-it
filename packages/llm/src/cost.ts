// What one call used, as Anthropic reports it. Output tokens include adaptive thinking. The price
// per model is in models.ts.
export type TokenUsage = { inputTokens: number; outputTokens: number };

import type { TokenUsage } from "./cost.js";

// Section 5.5. The adapter raises the first nine; the screen job sets the others.
export const SCREENING_FAILURE_CODES = [
  "timeout",
  "provider_unavailable",
  "rate_limited",
  "schema_invalid",
  "truncated",
  "refused",
  "request_rejected",
  "auth_failed",
  "unexpected_model",
  "attempts_exhausted",
  "cap_reached",
  "spend_cap_reached",
  "not_configured",
  "paused",
] as const;
export type ScreeningFailureCode = (typeof SCREENING_FAILURE_CODES)[number];

export type AdapterFailureCode = Extract<
  ScreeningFailureCode,
  | "timeout"
  | "provider_unavailable"
  | "rate_limited"
  | "schema_invalid"
  | "truncated"
  | "refused"
  | "request_rejected"
  | "auth_failed"
  | "unexpected_model"
>;

// Retried once by the screen job, 30 s later. truncated is never retried: no larger retry, the
// output cap is the cost bound.
const RETRYABLE: readonly ScreeningFailureCode[] = ["timeout", "provider_unavailable", "rate_limited", "schema_invalid"];

export function isRetryable(code: ScreeningFailureCode): boolean {
  return RETRYABLE.includes(code);
}

export const RETRY_DELAY_SECONDS = 30;
export const MAX_RATE_LIMIT_DELAY_SECONDS = 60;

// The pg-boss retry delay of a retryable failure (section 5.5), in whole seconds.
export function retryDelaySeconds(error: ClaudeError): number {
  if (error.code !== "rate_limited" || error.retryAfterSeconds === null) return RETRY_DELAY_SECONDS;
  return Math.min(MAX_RATE_LIMIT_DELAY_SECONDS, Math.max(1, Math.ceil(error.retryAfterSeconds)));
}

export type ClaudeErrorFields = {
  code: AdapterFailureCode;
  status: number | null;
  retryAfterSeconds?: number | null | undefined;
  // Present when Anthropic reported usage: the call was billed even though it failed. The adapter
  // prices it at the requested model's rates.
  billed?: { usage: TokenUsage; costMicroUsd: number } | null | undefined;
};

// Carries the failure code, HTTP status, retry-after and usage only. The message is fixed, and
// there is no cause, so the error never holds request headers, the request body or the raw
// response body, any of which may carry the API key or listing text.
export class ClaudeError extends Error {
  readonly code: AdapterFailureCode;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly retryable: boolean;
  readonly usage: TokenUsage | null;
  readonly costMicroUsd: number | null;

  constructor(fields: ClaudeErrorFields) {
    const status = fields.status === null ? "" : ` (HTTP ${fields.status})`;
    super(`Claude screening failed: ${fields.code}${status}`);
    this.name = "ClaudeError";
    this.code = fields.code;
    this.status = fields.status;
    this.retryAfterSeconds = fields.retryAfterSeconds ?? null;
    this.retryable = isRetryable(fields.code);
    this.usage = fields.billed?.usage ?? null;
    // Without usage the screen job settles the worst case: the request may have been billed.
    this.costMicroUsd = fields.billed?.costMicroUsd ?? null;
  }
}

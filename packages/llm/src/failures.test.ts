import { describe, expect, it } from "vitest";
import { ClaudeError, SCREENING_FAILURE_CODES, isRetryable, retryDelaySeconds } from "./failures.js";

describe("isRetryable", () => {
  it("retries only timeout, provider_unavailable, rate_limited and schema_invalid (section 5.5)", () => {
    const retried = SCREENING_FAILURE_CODES.filter(isRetryable);
    expect(retried).toEqual(["timeout", "provider_unavailable", "rate_limited", "schema_invalid"]);
    expect(SCREENING_FAILURE_CODES).toHaveLength(14);
  });
});

describe("retryDelaySeconds", () => {
  it("waits 30 s, or retry-after for a 429 at most 60 s", () => {
    expect(retryDelaySeconds(new ClaudeError({ code: "timeout", status: null }))).toBe(30);
    expect(retryDelaySeconds(new ClaudeError({ code: "provider_unavailable", status: 529, retryAfterSeconds: 5 }))).toBe(30);
    expect(retryDelaySeconds(new ClaudeError({ code: "rate_limited", status: 429, retryAfterSeconds: 12 }))).toBe(12);
    expect(retryDelaySeconds(new ClaudeError({ code: "rate_limited", status: 429, retryAfterSeconds: 0.4 }))).toBe(1);
    expect(retryDelaySeconds(new ClaudeError({ code: "rate_limited", status: 429, retryAfterSeconds: 600 }))).toBe(60);
    expect(retryDelaySeconds(new ClaudeError({ code: "rate_limited", status: 429 }))).toBe(30);
  });
});

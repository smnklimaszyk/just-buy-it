import { z } from "zod";
import { costMicroUsd, type TokenUsage } from "./cost.js";
import { ClaudeError, type AdapterFailureCode } from "./failures.js";
import { SYSTEM_PROMPT } from "./prompt.v1.js";
import { ANSWER_JSON_SCHEMA, parseAnswer, type ScreeningAnswer } from "./schema.js";
import {
  ANTHROPIC_MESSAGES_URL,
  ANTHROPIC_VERSION,
  EFFORT,
  INFERENCE_GEO,
  MAX_TOKENS,
  MODEL,
  REQUEST_TIMEOUT_MS,
} from "./screening-config.v1.js";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ClaudeScreenerOptions = {
  apiKey: string;
  fetchFn: FetchFn;
  timeoutMs?: number | undefined;
};

export type ScreeningResult = {
  answer: ScreeningAnswer;
  model: string;
  usage: TokenUsage;
  costMicroUsd: number;
  inferenceGeo: string | null;
};

export type ClaudeScreener = {
  // One paid call. Retries are the job's (section 5.5), never the adapter's.
  screen(userMessage: string, signal?: AbortSignal): Promise<ScreeningResult>;
};

// The parts of a Messages API response the adapter reads; everything else is ignored.
const messageSchema = z.object({
  model: z.string(),
  stop_reason: z.string().nullable(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    inference_geo: z.string().nullish(),
  }),
});

// Section 5.3. No tools, no fallbacks and no fallback beta header: no other model answers in
// place of the configured one (ADR 0019). No prompt caching: the system prompt is below the
// cacheable minimum.
function requestBody(userMessage: string): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: EFFORT, format: { type: "json_schema", schema: ANSWER_JSON_SCHEMA } },
    inference_geo: INFERENCE_GEO,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });
}

// Section 5.5 table for an HTTP error. 529 is "overloaded".
function statusCode(status: number): AdapterFailureCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status >= 500) return "provider_unavailable";
  return "request_rejected";
}

// The retry-after header in whole or decimal seconds; anything else is unknown.
function retryAfter(headers: Headers): number | null {
  const value = headers.get("retry-after");
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  return Number(value.trim());
}

// undefined for text that is not JSON, which the answer schema then rejects.
function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// A request or body read that failed without an HTTP answer. The caught error is dropped: it may
// carry the request. An abort by the job's deadline also means no answer in time.
function transportFailure(timeout: AbortSignal, signal: AbortSignal | undefined): ClaudeError {
  const aborted = timeout.aborted || signal?.aborted === true;
  return new ClaudeError({ code: aborted ? "timeout" : "provider_unavailable", status: null });
}

export function createClaudeScreener(options: ClaudeScreenerOptions): ClaudeScreener {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    async screen(userMessage, signal) {
      const timeout = AbortSignal.timeout(timeoutMs);
      let response: Response;
      try {
        response = await options.fetchFn(ANTHROPIC_MESSAGES_URL, {
          method: "POST",
          headers: {
            "x-api-key": options.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: requestBody(userMessage),
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch {
        throw transportFailure(timeout, signal);
      }
      const status = response.status;
      if (!response.ok) {
        // The error body may echo the request; it is never read.
        await response.body?.cancel().catch(() => undefined);
        throw new ClaudeError({ code: statusCode(status), status, retryAfterSeconds: retryAfter(response.headers) });
      }
      let text: string;
      try {
        // The timeout covers the body too.
        text = await response.text();
      } catch {
        throw transportFailure(timeout, signal);
      }
      const envelope = messageSchema.safeParse(parseJson(text));
      if (!envelope.success) throw new ClaudeError({ code: "schema_invalid", status });
      const message = envelope.data;
      const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
      // stop_reason first: a cut-off answer is never parsed.
      if (message.stop_reason === "max_tokens") throw new ClaudeError({ code: "truncated", status, usage });
      if (message.stop_reason === "refusal") throw new ClaudeError({ code: "refused", status, usage });
      const parsed = parseAnswer(parseJson(message.content.findLast((block) => block.type === "text")?.text));
      if (!parsed.ok) throw new ClaudeError({ code: "schema_invalid", status, usage });
      if (message.model !== MODEL) throw new ClaudeError({ code: "unexpected_model", status, usage });
      return {
        answer: parsed.answer,
        model: message.model,
        usage,
        costMicroUsd: costMicroUsd(usage),
        inferenceGeo: message.usage.inference_geo ?? null,
      };
    },
  };
}

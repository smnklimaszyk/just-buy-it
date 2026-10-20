import { z } from "zod";
import { EbayError, type EbayOperation } from "./errors.js";

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ClockLike = { now(): Date };

export const DEFAULT_TIMEOUT_MS = 10_000;

export type AppTokenCache = { get(signal?: AbortSignal): Promise<string>; invalidate(token: string): void };

export type GetJsonOptions = {
  operation: EbayOperation;
  fetchFn: FetchFn;
  token: AppTokenCache;
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  // Runs before every attempt, once the token is in hand. Throwing stops the call before the request.
  beforeAttempt: (attemptsSoFar: number) => Promise<void>;
};

// Internal transport for GET calls with the A20 policy: a 10 s timeout per attempt; 429 is not
// retried; 5xx, timeout and network errors are retried once, immediately; a 401 drops the token and
// tries once more with a fresh one; a caller abort stops at once. So there are at most 3 attempts.
export async function getJson(options: GetJsonOptions): Promise<{ body: unknown; attempts: number }> {
  const { operation } = options;
  let attempts = 0;
  let retried = false;
  let refreshed = false;
  for (;;) {
    const accessToken = await options.token.get(options.signal).catch((error: unknown) => {
      // The token cache reports an abort under its own operation; the caller asked for this one.
      if (options.signal?.aborted) throw new EbayError({ kind: "aborted", operation, attempts });
      throw error;
    });
    await options.beforeAttempt(attempts);
    attempts += 1;
    let response: Response;
    const timeout = AbortSignal.timeout(options.timeoutMs);
    try {
      response = await options.fetchFn(options.url, {
        headers: { ...options.headers, authorization: `Bearer ${accessToken}` },
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
      });
    } catch {
      if (options.signal?.aborted) throw new EbayError({ kind: "aborted", operation, attempts });
      if (!retried) {
        retried = true;
        continue;
      }
      throw new EbayError({ kind: timeout.aborted ? "timeout" : "network", operation, attempts });
    }
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (options.signal?.aborted) throw new EbayError({ kind: "aborted", operation, attempts });
        if (!timeout.aborted) throw new EbayError({ kind: "invalid_response", operation, attempts });
        // The timeout also covers the body; a body that stalls counts as a timed-out attempt.
        if (!retried) {
          retried = true;
          continue;
        }
        throw new EbayError({ kind: "timeout", operation, attempts });
      }
      return { body, attempts };
    }
    if (response.status === 401 && !refreshed) {
      options.token.invalidate(accessToken);
      refreshed = true;
      continue;
    }
    if (response.status >= 500 && !retried) {
      retried = true;
      continue;
    }
    throw new EbayError({
      kind:
        response.status === 401
          ? "unauthorized"
          : response.status === 429
            ? "rate_limited"
            : response.status >= 500
              ? "server_error"
              : "client_error",
      operation,
      status: response.status,
      errorIds: await errorIds(response),
      attempts,
    });
  }
}

const errorBodySchema = z.object({ errors: z.array(z.object({ errorId: z.number().int() })) });

// Only the numeric error ids are kept; messages may echo the request.
async function errorIds(response: Response): Promise<number[]> {
  const parsed = errorBodySchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success ? parsed.data.errors.map((e) => e.errorId) : [];
}

import { z } from "zod";
import { EbayError, type EbayErrorKind } from "./errors.js";
import { DEFAULT_TIMEOUT_MS, type AppTokenCache, type ClockLike, type FetchFn } from "./http.js";

export type AppTokenCacheOptions = {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetchFn: FetchFn;
  clock: ClockLike;
  timeoutMs?: number;
  // Called before every token POST, for api_usage_hourly. A cache hit makes no request.
  onRequest?: () => void;
};

const REFRESH_EARLY_MS = 5 * 60_000;

const tokenSchema = z.object({ access_token: z.string().min(1), expires_in: z.number() });

// eBay answers bad client credentials with 400 or 401.
function tokenStatusKind(status: number): EbayErrorKind {
  if (status === 400 || status === 401) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

function abortedError(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new EbayError({ kind: "aborted", operation: "token", attempts: 0 }));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

// Client credentials token for the application. The token POST is never retried, and the token is
// never logged, stored or put into an error.
export function createAppTokenCache(options: AppTokenCacheOptions): AppTokenCache {
  const { apiBase, clientId, clientSecret, fetchFn, clock } = options;

  let cached: { value: string; refreshAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function get(signal?: AbortSignal): Promise<string> {
    if (cached && clock.now().getTime() < cached.refreshAt) return cached.value;
    inFlight ??= requestToken().finally(() => {
      inFlight = undefined;
    });
    if (!signal) return inFlight;
    // A caller's abort only ends its own wait; the shared request keeps running for the others.
    return Promise.race([inFlight, abortedError(signal)]);
  }

  async function requestToken(): Promise<string> {
    let response: Response;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.onRequest?.();
    try {
      response = await fetchFn(`${apiBase}/identity/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
        signal: timeout,
      });
    } catch {
      throw new EbayError({ kind: timeout.aborted ? "timeout" : "network", operation: "token", attempts: 1 });
    }
    if (!response.ok) {
      throw new EbayError({ kind: tokenStatusKind(response.status), operation: "token", status: response.status, attempts: 1 });
    }
    const parsed = tokenSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new EbayError({ kind: "invalid_response", operation: "token", attempts: 1 });
    const { access_token, expires_in } = parsed.data;
    cached = { value: access_token, refreshAt: clock.now().getTime() + expires_in * 1000 - REFRESH_EARLY_MS };
    return access_token;
  }

  // Only the token that eBay rejected is dropped, so parallel 401s on one token cause one refresh.
  function invalidate(token: string): void {
    if (cached?.value === token) cached = undefined;
  }

  return { get, invalidate };
}

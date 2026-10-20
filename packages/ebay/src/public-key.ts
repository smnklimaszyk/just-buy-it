import { z } from "zod";
import { EbayError } from "./errors.js";
import { DEFAULT_TIMEOUT_MS, getJson, type AppTokenCache, type ClockLike, type FetchFn } from "./http.js";
import { createLru } from "./lru.js";

export type KeyLookup =
  | { kind: "key"; key: string; stale: boolean }
  | { kind: "rejected" }
  | { kind: "limited" }
  | { kind: "unavailable"; error: EbayError };

export type PublicKeyClientOptions = {
  apiBase: string;
  token: AppTokenCache;
  fetchFn: FetchFn;
  clock: ClockLike;
  timeoutMs?: number;
  // Called before every HTTP attempt, retries included, for api_usage_hourly.
  onRequest?: () => void;
};

// eBay recommends caching notification public keys for about one hour.
const KEY_CACHE_MS = 60 * 60_000;
const REJECTED_CACHE_MS = 60 * 60_000;
// Transient eBay failures are kept short, so one bad minute does not block genuine notifications.
const UNAVAILABLE_CACHE_MS = 60_000;
const STALE_KEY_MS = 24 * 60 * 60_000;
const KNOWN_KEYS = 100;
const REJECTED_IDS = 10_000;
const UNAVAILABLE_IDS = 10_000;
// At most 10 fetches for unknown key ids in any 60 minutes (ADR 0013).
const UNKNOWN_FETCHES_PER_WINDOW = 10;
const UNKNOWN_FETCH_WINDOW_MS = 60 * 60_000;

const publicKeySchema = z.object({ key: z.string().min(1) });

// One fetch at a time, across all key ids, handed over in arrival order. A waiter whose signal
// aborts leaves the line; acquire then answers false.
function createFetchSlot() {
  let held = false;
  const waiting: (() => void)[] = [];

  function acquire(signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (!held) {
      held = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = () => {
        signal?.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        waiting.splice(waiting.indexOf(grant), 1);
        resolve(false);
      };
      signal?.addEventListener("abort", leave, { once: true });
      waiting.push(grant);
    });
  }

  function release(): void {
    const next = waiting.shift();
    if (next) next();
    else held = false;
  }

  return { acquire, release };
}

// The Notification API key lookup is not a Browse call, so it reserves nothing (ADR 0013).
export function createPublicKeyClient(options: PublicKeyClientOptions) {
  const { apiBase, token, fetchFn, clock } = options;
  const keys = createLru<string, { key: string; fetchedAt: number }>(KNOWN_KEYS);
  const rejected = createLru<string, number>(REJECTED_IDS);
  const unavailable = createLru<string, { error: EbayError; failedAt: number }>(UNAVAILABLE_IDS);
  const slot = createFetchSlot();
  const unknownFetchStarts: number[] = [];

  function fromCache(kid: string): KeyLookup | undefined {
    const now = clock.now().getTime();
    const known = keys.get(kid);
    if (known && now - known.fetchedAt < KEY_CACHE_MS) return { kind: "key", key: known.key, stale: false };
    const rejectedAt = rejected.get(kid);
    if (rejectedAt !== undefined && now - rejectedAt < REJECTED_CACHE_MS) return { kind: "rejected" };
    const failed = unavailable.get(kid);
    if (failed && now - failed.failedAt < UNAVAILABLE_CACHE_MS) return unavailableOrStale(kid, failed.error);
    return undefined;
  }

  // eBay's keys are long-lived and its retries end after 24 h, so a key fetched within that time
  // still verifies while eBay is down. A refresh that eBay rejects removes it.
  function unavailableOrStale(kid: string, error: EbayError): KeyLookup {
    const known = keys.get(kid);
    if (known && clock.now().getTime() - known.fetchedAt < STALE_KEY_MS) return { kind: "key", key: known.key, stale: true };
    return { kind: "unavailable", error };
  }

  async function lookupKey(kid: string, signal?: AbortSignal): Promise<KeyLookup> {
    const cached = fromCache(kid);
    if (cached) return cached;
    if (!(await slot.acquire(signal))) {
      return { kind: "unavailable", error: new EbayError({ kind: "aborted", operation: "public_key", attempts: 0 }) };
    }
    try {
      // A waiter for the same key id finds what the fetch before it stored.
      const stored = fromCache(kid);
      if (stored) return stored;
      if (!keys.get(kid) && !takeUnknownFetch()) return { kind: "limited" };
      return await fetchAndStore(kid, signal);
    } finally {
      slot.release();
    }
  }

  // A key id that was never fetched successfully is unknown. Refreshing a known key does not use
  // this budget, so a flood of random key ids cannot block the refresh of eBay's real key.
  function takeUnknownFetch(): boolean {
    const now = clock.now().getTime();
    while (unknownFetchStarts[0] !== undefined && now - unknownFetchStarts[0] >= UNKNOWN_FETCH_WINDOW_MS) {
      unknownFetchStarts.shift();
    }
    if (unknownFetchStarts.length >= UNKNOWN_FETCHES_PER_WINDOW) return false;
    unknownFetchStarts.push(now);
    return true;
  }

  async function fetchAndStore(kid: string, signal: AbortSignal | undefined): Promise<KeyLookup> {
    try {
      const key = await fetchKey(kid, signal);
      keys.set(kid, { key, fetchedAt: clock.now().getTime() });
      rejected.delete(kid);
      unavailable.delete(kid);
      return { kind: "key", key, stale: false };
    } catch (error) {
      if (!(error instanceof EbayError)) throw error;
      if (isRejection(error)) {
        rejected.set(kid, clock.now().getTime());
        keys.delete(kid);
        return { kind: "rejected" };
      }
      // An abort is our own shutdown, not an answer from eBay.
      if (error.kind === "aborted") return { kind: "unavailable", error };
      unavailable.set(kid, { error, failedAt: clock.now().getTime() });
      return unavailableOrStale(kid, error);
    }
  }

  async function fetchKey(kid: string, signal: AbortSignal | undefined): Promise<string> {
    const { body, attempts } = await getJson({
      operation: "public_key",
      fetchFn,
      token,
      url: `${apiBase}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      headers: { accept: "application/json" },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal,
      beforeAttempt: async () => options.onRequest?.(),
    });
    const parsed = publicKeySchema.safeParse(body);
    if (!parsed.success) throw new EbayError({ kind: "invalid_response", operation: "public_key", attempts });
    return parsed.data.key;
  }

  return { lookupKey };
}

// eBay no longer accepts this key id. A 401 or 429, or a token failure, says nothing about the key.
function isRejection(error: EbayError): boolean {
  return (
    error.operation === "public_key" &&
    error.kind === "client_error" &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500
  );
}

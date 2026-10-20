import { z } from "zod";
import { EbayError } from "./errors.js";
import { DEFAULT_TIMEOUT_MS, getJson, type AppTokenCache, type ClockLike, type FetchFn } from "./http.js";

export type PublicKeyClientOptions = {
  apiBase: string;
  token: AppTokenCache;
  fetchFn: FetchFn;
  clock: ClockLike;
  timeoutMs?: number;
};

// eBay recommends caching notification public keys for about one hour.
const KEY_CACHE_MS = 60 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const MAX_FAILURES = 1000;

const publicKeySchema = z.object({ key: z.string().min(1) });

// The Notification API key lookup is not a Browse call, so it reserves nothing (ADR 0013).
export function createPublicKeyClient(options: PublicKeyClientOptions) {
  const { apiBase, token, fetchFn, clock } = options;
  const keys = new Map<string, { key: string; fetchedAt: number }>();
  const failures = new Map<string, { error: unknown; failedAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  async function getKey(kid: string): Promise<string> {
    const cached = keys.get(kid);
    if (cached && clock.now().getTime() - cached.fetchedAt < KEY_CACHE_MS) return cached.key;
    const failed = failures.get(kid);
    if (failed && clock.now().getTime() - failed.failedAt < FAILURE_CACHE_MS) throw failed.error;

    const running = inFlight.get(kid);
    if (running) return running;
    const lookup = fetchKey(kid)
      .then((key) => {
        keys.set(kid, { key, fetchedAt: clock.now().getTime() });
        return key;
      })
      .catch((error: unknown) => {
        failures.set(kid, { error, failedAt: clock.now().getTime() });
        // Maps keep insertion order, so the first entry is the oldest failure.
        if (failures.size > MAX_FAILURES) failures.delete(failures.keys().next().value ?? kid);
        throw error;
      })
      .finally(() => inFlight.delete(kid));
    inFlight.set(kid, lookup);
    return lookup;
  }

  async function fetchKey(kid: string): Promise<string> {
    const { body, attempts } = await getJson({
      operation: "public_key",
      fetchFn,
      token,
      url: `${apiBase}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`,
      headers: { accept: "application/json" },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      beforeAttempt: async () => undefined,
    });
    const parsed = publicKeySchema.safeParse(body);
    if (!parsed.success) throw new EbayError({ kind: "invalid_response", operation: "public_key", attempts });
    return parsed.data.key;
  }

  return { getKey };
}

import { createAppTokenCache, createPublicKeyClient, EbayError, type ClockLike, type FetchFn } from "@ebay-sniper/ebay";
import type { LookupKey } from "./notifications.js";

// ADR 0007: the server's token and getPublicKey calls time out after 5 s.
export const EBAY_TIMEOUT_MS = 5_000;

export type KeyLookupWiring = {
  apiBase: string;
  credentials: { clientId: string; clientSecret: string } | undefined;
  fetchFn: FetchFn;
  clock: ClockLike;
  // Adds one call to app.api_usage_hourly.
  countRequest: (resource: string, purpose: string) => void;
};

export function createKeyLookup(options: KeyLookupWiring): LookupKey {
  const { apiBase, credentials, fetchFn, clock, countRequest } = options;
  if (!credentials) {
    // The challenge works before the credentials exist; every notification counts key_unavailable.
    return async () => ({
      kind: "unavailable",
      error: new EbayError({ kind: "not_configured", operation: "token", attempts: 0 }),
    });
  }
  const token = createAppTokenCache({
    apiBase,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    fetchFn,
    clock,
    timeoutMs: EBAY_TIMEOUT_MS,
    onRequest: () => countRequest("identity.oauth2", "token"),
  });
  const keys = createPublicKeyClient({
    apiBase,
    token,
    fetchFn,
    clock,
    timeoutMs: EBAY_TIMEOUT_MS,
    onRequest: () => countRequest("commerce.notification", "deletion-key"),
  });
  return keys.lookupKey;
}

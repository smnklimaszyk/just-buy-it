import { z } from "zod";

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PublicKeyClientOptions = {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetchFn: FetchFn;
  now: () => number;
};

// eBay recommends caching notification public keys for about one hour.
const KEY_CACHE_MS = 60 * 60_000;

const tokenSchema =z.object({ access_token: z.string().min(1), expires_in: z.number() });
const publicKeySchema = z.object({ key: z.string().min(1) });

export function createPublicKeyClient(options: PublicKeyClientOptions) {
  const { apiBase, clientId, clientSecret, fetchFn } = options;

  let token: { value: string; refreshAt: number } | undefined;

  async function getAppToken(): Promise<string> {
    if (token && options.now() < token.refreshAt) return token.value;
    return requestAppToken();
  }

  async function requestAppToken(): Promise<string> {
    const response = await fetchFn(`${apiBase}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`eBay token request failed with status ${response.status}`);
    const { access_token, expires_in } = tokenSchema.parse(await response.json());
    token = { value: access_token, refreshAt: options.now() + expires_in * 1000 - 5 * 60_000 };
    return access_token;
  }

  const keys = new Map<string, { key: string; fetchedAt: number }>();
  const failures = new Map<string, { error: unknown; failedAt: number }>();
  const inFlight = new Map<string, Promise<string>>();

  async function getKey(kid: string): Promise<string> {
    const cached = keys.get(kid);
    if (cached && options.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.key;
    const failed = failures.get(kid);
    if (failed && options.now() - failed.failedAt < 60_000) throw failed.error;

    const running = inFlight.get(kid);
    if (running) return running;
    const lookup = fetchKey(kid)
      .then((key) => {
        keys.set(kid, { key, fetchedAt: options.now() });
        return key;
      })
      .catch((error: unknown) => {
        failures.set(kid, { error, failedAt: options.now() });
        // Maps keep insertion order, so the first entry is the oldest failure.
        if (failures.size > 1000) failures.delete(failures.keys().next().value ?? kid);
        throw error;
      })
      .finally(() => inFlight.delete(kid));
    inFlight.set(kid, lookup);
    return lookup;
  }

  async function fetchKey(kid: string): Promise<string> {
    const token = await getAppToken();
    const response = await fetchFn(`${apiBase}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`eBay public key request failed with status ${response.status}`);
    return publicKeySchema.parse(await response.json()).key;
  }

  return { getKey };
}

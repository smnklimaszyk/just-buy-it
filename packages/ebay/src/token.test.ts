import { describe, expect, it } from "vitest";
import { EbayError } from "./errors.js";
import { createAppTokenCache } from "./token.js";

type Call = { url: string; init: RequestInit | undefined };

function fakeTokenEndpoint(respond: (n: number) => Response | Promise<Response> = (n) => tokenResponse(`token-${n}`)) {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return respond(calls.length);
  };
  return { calls, fetchFn };
}

function tokenResponse(token: string, expiresIn = 7200): Response {
  return Response.json({ access_token: token, expires_in: expiresIn, token_type: "Application Access Token" });
}

// Behaves like fetch on a host that never answers: it settles only when the signal aborts.
function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function clockAt(ms: { value: number }) {
  return { now: () => new Date(ms.value) };
}

describe("createAppTokenCache", () => {
  it("gets an application token with client credentials", async () => {
    const ebay = fakeTokenEndpoint();
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    await expect(cache.get()).resolves.toBe("token-1");

    expect(ebay.calls.map((c) => c.url)).toEqual(["https://api.ebay.com/identity/v1/oauth2/token"]);
    const init = ebay.calls[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${Buffer.from("app-id:cert-id").toString("base64")}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(String(init?.body)).toBe(
      "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    );
  });

  it("reuses the token until five minutes before it expires", async () => {
    const ebay = fakeTokenEndpoint();
    const now = { value: 0 };
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt(now),
    });

    await cache.get();
    now.value = 114 * 60_000;
    await expect(cache.get()).resolves.toBe("token-1");
    expect(ebay.calls).toHaveLength(1);

    now.value = 116 * 60_000;
    await expect(cache.get()).resolves.toBe("token-2");
    expect(ebay.calls).toHaveLength(2);
  });

  it("shares one request between ten parallel callers", async () => {
    const ebay = fakeTokenEndpoint();
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    const tokens = await Promise.all(Array.from({ length: 10 }, () => cache.get()));

    expect(new Set(tokens)).toEqual(new Set(["token-1"]));
    expect(ebay.calls).toHaveLength(1);
  });

  it("drops the cached token on invalidate, but keeps a newer one when the stale token is invalidated", async () => {
    const ebay = fakeTokenEndpoint();
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    const first = await cache.get();
    cache.invalidate(first);
    await expect(cache.get()).resolves.toBe("token-2");

    cache.invalidate(first);
    await expect(cache.get()).resolves.toBe("token-2");
    expect(ebay.calls).toHaveLength(2);
  });

  it("fails with unauthorized on a 401 and does not retry", async () => {
    const ebay = fakeTokenEndpoint(() => Response.json({ error: "invalid_client" }, { status: 401 }));
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "wrong",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    const error = await cache.get().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EbayError);
    expect(error).toMatchObject({ kind: "unauthorized", operation: "token", status: 401, attempts: 1 });
    expect((error as EbayError).message).toBe("eBay token failed: unauthorized (HTTP 401)");
    expect(ebay.calls).toHaveLength(1);
  });

  it("fails with timeout when eBay does not answer in time, and does not retry", async () => {
    let requests = 0;
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: (_input, init) => {
        requests += 1;
        return waitForAbort(init?.signal);
      },
      clock: clockAt({ value: 0 }),
      timeoutMs: 20,
    });

    await expect(cache.get()).rejects.toMatchObject({ kind: "timeout", operation: "token", attempts: 1 });
    expect(requests).toBe(1);
  });

  it("lets one caller stop waiting without cancelling the shared request for the others", async () => {
    let answer: (response: Response) => void = () => undefined;
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
      clock: clockAt({ value: 0 }),
    });
    const caller = new AbortController();

    const abandoned = cache.get(caller.signal);
    const waiting = cache.get();
    caller.abort();
    answer(tokenResponse("token-1"));

    await expect(abandoned).rejects.toMatchObject({ kind: "aborted", operation: "token" });
    await expect(waiting).resolves.toBe("token-1");
  });

  it("fails with network when the request cannot be sent, and does not retry", async () => {
    let requests = 0;
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: async () => {
        requests += 1;
        throw new TypeError("fetch failed");
      },
      clock: clockAt({ value: 0 }),
    });

    await expect(cache.get()).rejects.toMatchObject({ kind: "network", operation: "token", attempts: 1 });
    expect(requests).toBe(1);
  });

  it("fails with invalid_response when the body has the wrong shape, and does not cache the failure", async () => {
    const ebay = fakeTokenEndpoint((n) => (n === 1 ? Response.json({ token: "x" }) : tokenResponse("token-2")));
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    await expect(cache.get()).rejects.toMatchObject({ kind: "invalid_response", operation: "token", attempts: 1 });
    await expect(cache.get()).resolves.toBe("token-2");
  });

  it.each([
    [400, "unauthorized"],
    [403, "client_error"],
    [429, "rate_limited"],
    [503, "server_error"],
  ])("maps HTTP %i to %s without a retry", async (status, kind) => {
    const ebay = fakeTokenEndpoint(() => Response.json({}, { status }));
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      clock: clockAt({ value: 0 }),
    });

    await expect(cache.get()).rejects.toMatchObject({ kind, operation: "token", status, attempts: 1 });
    expect(ebay.calls).toHaveLength(1);
  });

  it("never puts the token or the client secret into an error", async () => {
    const cache = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "secret-sentinel",
      fetchFn: async () => Response.json({ access_token: "token-sentinel", expires_in: "soon" }),
      clock: clockAt({ value: 0 }),
    });

    const error = await cache.get().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EbayError);
    const dump = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
    expect(dump).not.toContain("token-sentinel");
    expect(dump).not.toContain("secret-sentinel");
  });
});

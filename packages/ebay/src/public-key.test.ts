import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { Lru } from "./lru.js";
import { createPublicKeyClient, type PublicKeyClientOptions } from "./public-key.js";
import { createAppTokenCache } from "./token.js";

// Records each cache's capacity and the keys stored in it; the caches themselves stay real.
const caches = vi.hoisted(() => [] as { capacity: number; stored: unknown[] }[]);
vi.mock("./lru.js", async (importOriginal) => {
  const actual = await importOriginal<{ createLru: <K, V>(capacity: number) => Lru<K, V> }>();
  return {
    createLru: <K, V>(capacity: number): Lru<K, V> => {
      const lru = actual.createLru<K, V>(capacity);
      const stored: K[] = [];
      caches.push({ capacity, stored });
      return {
        get: (key) => lru.get(key),
        set: (key, value) => {
          stored.push(key);
          lru.set(key, value);
        },
        delete: (key) => lru.delete(key),
        get size() {
          return lru.size;
        },
      };
    },
  };
});

// Moved from apps/server/src/ebay-keys.test.ts. The token tests moved to token.test.ts.

type Call = { url: string; init: RequestInit | undefined };
type KeyResponder = (url: string, n: number) => Response | Promise<Response>;

const PEM = "-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----";
const keyResponse = () => Response.json({ key: PEM, algorithm: "ECDSA", digest: "SHA1" });

function fakeEbay(respond: KeyResponder = keyResponse) {
  const calls: Call[] = [];
  let tokens = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/identity/v1/oauth2/token")) {
      tokens += 1;
      return Response.json({ access_token: `app-token-${tokens}`, expires_in: 7200 });
    }
    return respond(url, calls.filter((c) => c.url.includes("/public_key/")).length);
  };
  const keyCalls = () => calls.filter((c) => c.url.includes("/public_key/"));
  return { calls, keyCalls, fetchFn, tokenRequests: () => tokens };
}

function keyClient(
  ebay: ReturnType<typeof fakeEbay>,
  now: { value: number } = { value: 0 },
  extra: Pick<PublicKeyClientOptions, "onRequest"> = {},
) {
  const clock = { now: () => new Date(now.value) };
  const token = createAppTokenCache({
    apiBase: "https://api.ebay.com",
    clientId: "app-id",
    clientSecret: "cert-id",
    fetchFn: ebay.fetchFn,
    clock,
  });
  return createPublicKeyClient({ apiBase: "https://api.ebay.com", token, fetchFn: ebay.fetchFn, clock, ...extra });
}

const fresh = { kind: "key", key: PEM, stale: false };

describe("createPublicKeyClient", () => {
  it("gets the public key for the key id with the application token", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);

    expect(ebay.calls.map((c) => c.url)).toEqual([
      "https://api.ebay.com/identity/v1/oauth2/token",
      "https://api.ebay.com/commerce/notification/v1/public_key/kid-1",
    ]);
    expect(new Headers(ebay.calls[1]?.init?.headers).get("authorization")).toBe("Bearer app-token-1");
  });

  it("encodes the key id in the path and sends every request with a timeout signal", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    await client.lookupKey("../a b/?x");

    expect(ebay.keyCalls()[0]?.url).toBe(
      "https://api.ebay.com/commerce/notification/v1/public_key/..%2Fa%20b%2F%3Fx",
    );
    expect(ebay.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("answers rejected when eBay answers the key lookup with a 4xx other than 401 and 429", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [{ errorId: 195000 }] }, { status: 404 }));
    const client = keyClient(ebay);

    await expect(client.lookupKey("kid-1")).resolves.toEqual({ kind: "rejected" });
    expect(ebay.keyCalls()).toHaveLength(1);
  });

  it("caches a rejected key id for one hour", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [] }, { status: 404 }));
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await client.lookupKey("kid-1");
    now.value = 59 * 60_000;
    await expect(client.lookupKey("kid-1")).resolves.toEqual({ kind: "rejected" });
    expect(ebay.keyCalls()).toHaveLength(1);

    now.value = 61 * 60_000;
    await expect(client.lookupKey("kid-1")).resolves.toEqual({ kind: "rejected" });
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("makes one HTTP request at a time across key ids and allows 10 unknown-key fetches an hour", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ebay = fakeEbay(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return Response.json({ errors: [] }, { status: 404 });
    });
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => client.lookupKey(`kid-${i}`)));

    expect(maxInFlight).toBe(1);
    expect(ebay.keyCalls()).toHaveLength(10);
    expect(results.filter((r) => r.kind === "rejected")).toHaveLength(10);
    expect(results.filter((r) => r.kind === "limited")).toHaveLength(40);

    now.value = 60 * 60_000 - 1;
    await expect(client.lookupKey("kid-late-1")).resolves.toEqual({ kind: "limited" });
    now.value = 60 * 60_000 + 1;
    await expect(client.lookupKey("kid-late-2")).resolves.toEqual({ kind: "rejected" });
    expect(ebay.keyCalls()).toHaveLength(11);
  });

  it("refreshes an expired known key without using the unknown-key budget", async () => {
    const ebay = fakeEbay((url) => (url.endsWith("/kid-known") ? keyResponse() : Response.json({}, { status: 404 })));
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await client.lookupKey("kid-known");
    now.value = 60 * 60_000 + 1;
    for (let i = 0; i < 10; i++) await client.lookupKey(`kid-${i}`);
    await expect(client.lookupKey("kid-11")).resolves.toEqual({ kind: "limited" });

    await expect(client.lookupKey("kid-known")).resolves.toEqual(fresh);
    expect(ebay.keyCalls().filter((c) => c.url.endsWith("/kid-known"))).toHaveLength(2);
  });

  it("falls back to a stored key under 24 hours old while eBay is unavailable", async () => {
    const ebay = fakeEbay((_url, n) => (n === 1 ? keyResponse() : new Response("busy", { status: 503 })));
    const now = { value: 0 };
    const client = keyClient(ebay, now);
    const stale = { kind: "key", key: PEM, stale: true };

    await client.lookupKey("kid-1");
    now.value = 60 * 60_000 + 1;
    await expect(client.lookupKey("kid-1")).resolves.toEqual(stale);
    expect(ebay.keyCalls()).toHaveLength(3);

    now.value += 59_000;
    await expect(client.lookupKey("kid-1")).resolves.toEqual(stale);
    expect(ebay.keyCalls()).toHaveLength(3);

    now.value = 24 * 60 * 60_000 + 1;
    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({ kind: "unavailable", error: { kind: "server_error" } });
  });

  it("removes the stored key when a refresh is rejected, so it is not used as a stale key", async () => {
    const answers = [keyResponse, () => Response.json({}, { status: 404 })];
    const ebay = fakeEbay((_url, n) => (answers[n - 1] ?? (() => new Response("busy", { status: 503 })))());
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await client.lookupKey("kid-1");
    now.value = 60 * 60_000 + 1;
    await expect(client.lookupKey("kid-1")).resolves.toEqual({ kind: "rejected" });

    now.value = 2 * 60 * 60_000 + 2;
    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({ kind: "unavailable" });
  });

  it("lets an aborted waiter leave the line with unavailable, and the next waiter still gets the slot", async () => {
    let answerFirst: (response: Response) => void = () => undefined;
    const ebay = fakeEbay((url) =>
      url.endsWith("/kid-1")
        ? new Promise<Response>((resolve) => {
            answerFirst = resolve;
          })
        : keyResponse(),
    );
    const client = keyClient(ebay);
    const caller = new AbortController();

    const first = client.lookupKey("kid-1");
    const abandoned = client.lookupKey("kid-2", caller.signal);
    const next = client.lookupKey("kid-3");
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort();

    await expect(abandoned).resolves.toMatchObject({
      kind: "unavailable",
      error: { kind: "aborted", operation: "public_key", attempts: 0 },
    });
    answerFirst(keyResponse());
    await expect(first).resolves.toEqual(fresh);
    await expect(next).resolves.toEqual(fresh);
    expect(ebay.keyCalls().map((c) => c.url.split("/").pop())).toEqual(["kid-1", "kid-3"]);
  });

  it("does not cache a lookup the caller aborted during the fetch as an eBay failure", async () => {
    const ebay = fakeEbay((_url, n) =>
      n === 1
        ? new Promise<Response>((_resolve, reject) => {
            caller.signal.addEventListener("abort", () => reject(caller.signal.reason));
          })
        : keyResponse(),
    );
    const caller = new AbortController();
    const client = keyClient(ebay);

    const aborted = client.lookupKey("kid-1", caller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    caller.abort();

    await expect(aborted).resolves.toMatchObject({ kind: "unavailable", error: { kind: "aborted" } });
    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("calls onRequest before every key request, retries included, and not on a cache hit", async () => {
    const events: string[] = [];
    const ebay = fakeEbay((_url, n) => {
      events.push("key request");
      return n === 1 ? new Response("busy", { status: 503 }) : keyResponse();
    });
    const client = keyClient(ebay, { value: 0 }, { onRequest: () => events.push("onRequest") });

    await client.lookupKey("kid-1");
    await client.lookupKey("kid-1");

    expect(events).toEqual(["onRequest", "key request", "onRequest", "key request"]);
  });

  it("answers unavailable for 401, 429, a bad body and a token failure, with an error that omits the key id", async () => {
    const cases: [KeyResponder, object][] = [
      [() => Response.json({ errors: [] }, { status: 401 }), { kind: "unauthorized", operation: "public_key", status: 401 }],
      [() => Response.json({ errors: [] }, { status: 429 }), { kind: "rate_limited", operation: "public_key", status: 429 }],
      [() => Response.json({ algorithm: "ECDSA" }), { kind: "invalid_response", operation: "public_key" }],
    ];
    for (const [respond, error] of cases) {
      const result = await keyClient(fakeEbay(respond)).lookupKey("kid-sentinel");
      expect(result).toMatchObject({ kind: "unavailable", error });
      expect(JSON.stringify(result)).not.toContain("kid-sentinel");
      if (result.kind === "unavailable") expect(String(result.error)).not.toContain("kid-sentinel");
    }

    const clock = { now: () => new Date(0) };
    const failingToken = createAppTokenCache({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: async () => Response.json({}, { status: 403 }),
      clock,
    });
    const client = createPublicKeyClient({ apiBase: "https://api.ebay.com", token: failingToken, fetchFn: async () => keyResponse(), clock });
    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({
      kind: "unavailable",
      error: { kind: "client_error", operation: "token", status: 403 },
    });
  });

  it("keeps at most 100 known keys, 10,000 rejected ids and 10,000 unavailable ids, each in an LRU", async () => {
    caches.length = 0;
    const ebay = fakeEbay((url) =>
      url.endsWith("/kid-ok")
        ? keyResponse()
        : url.endsWith("/kid-bad")
          ? Response.json({}, { status: 404 })
          : Response.json({}, { status: 429 }),
    );
    const client = keyClient(ebay);

    await client.lookupKey("kid-ok");
    await client.lookupKey("kid-bad");
    await client.lookupKey("kid-busy");

    const capacityOf = (kid: string) => caches.find((c) => c.stored.includes(kid))?.capacity;
    expect(capacityOf("kid-ok")).toBe(100);
    expect(capacityOf("kid-bad")).toBe(10_000);
    expect(capacityOf("kid-busy")).toBe(10_000);
    expect(new Set(["kid-ok", "kid-bad", "kid-busy"].map((kid) => caches.find((c) => c.stored.includes(kid))))).toHaveProperty("size", 3);
  });

  it("reuses a key for one hour and fetches it again after that", async () => {
    const ebay = fakeEbay();
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await client.lookupKey("kid-1");
    now.value = 59 * 60_000;
    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);
    expect(ebay.keyCalls()).toHaveLength(1);

    now.value = 60 * 60_000 + 1;
    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("caches an unavailable answer for 60 seconds, not for an hour", async () => {
    const ebay = fakeEbay(() => new Response("busy", { status: 503 }));
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({
      kind: "unavailable",
      error: { kind: "server_error", operation: "public_key", status: 503 },
    });
    expect(ebay.keyCalls()).toHaveLength(2);
    now.value = 59_000;
    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({ kind: "unavailable" });
    expect(ebay.keyCalls()).toHaveLength(2);

    now.value = 61_000;
    await expect(client.lookupKey("kid-1")).resolves.toMatchObject({ kind: "unavailable" });
    expect(ebay.keyCalls()).toHaveLength(4);
  });

  it("shares one eBay request between concurrent lookups of the same key id", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    const results = await Promise.all([client.lookupKey("kid-1"), client.lookupKey("kid-1"), client.lookupKey("kid-1")]);

    expect(results).toEqual([fresh, fresh, fresh]);
    expect(ebay.keyCalls()).toHaveLength(1);
    expect(ebay.tokenRequests()).toBe(1);
  });

  it("retries a 503 once and returns the key", async () => {
    const ebay = fakeEbay((_url, n) => (n === 1 ? new Response("busy", { status: 503 }) : keyResponse()));
    const client = keyClient(ebay);

    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("refreshes the token once after a 401", async () => {
    const ebay = fakeEbay((_url, n) => (n === 1 ? Response.json({ errors: [] }, { status: 401 }) : keyResponse()));
    const client = keyClient(ebay);

    await expect(client.lookupKey("kid-1")).resolves.toEqual(fresh);
    expect(ebay.tokenRequests()).toBe(2);
    expect(new Headers(ebay.keyCalls()[1]?.init?.headers).get("authorization")).toBe("Bearer app-token-2");
  });

  it("has no reservation step, because key lookups use the Notification API pool (ADR 0013)", () => {
    expectTypeOf<PublicKeyClientOptions>().not.toHaveProperty("reserve");
    expect(Object.keys(keyClient(fakeEbay()))).toEqual(["lookupKey"]);
  });
});

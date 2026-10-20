import { describe, expect, expectTypeOf, it } from "vitest";
import { createPublicKeyClient, type PublicKeyClientOptions } from "./public-key.js";
import { createAppTokenCache } from "./token.js";

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

function keyClient(ebay: ReturnType<typeof fakeEbay>, now: { value: number } = { value: 0 }) {
  const clock = { now: () => new Date(now.value) };
  const token = createAppTokenCache({
    apiBase: "https://api.ebay.com",
    clientId: "app-id",
    clientSecret: "cert-id",
    fetchFn: ebay.fetchFn,
    clock,
  });
  return createPublicKeyClient({ apiBase: "https://api.ebay.com", token, fetchFn: ebay.fetchFn, clock });
}

describe("createPublicKeyClient", () => {
  it("gets the public key for the key id with the application token", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    await expect(client.getKey("kid-1")).resolves.toBe(PEM);

    expect(ebay.calls.map((c) => c.url)).toEqual([
      "https://api.ebay.com/identity/v1/oauth2/token",
      "https://api.ebay.com/commerce/notification/v1/public_key/kid-1",
    ]);
    expect(new Headers(ebay.calls[1]?.init?.headers).get("authorization")).toBe("Bearer app-token-1");
  });

  it("encodes the key id in the path and sends every request with a timeout signal", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    await client.getKey("../a b/?x");

    expect(ebay.keyCalls()[0]?.url).toBe(
      "https://api.ebay.com/commerce/notification/v1/public_key/..%2Fa%20b%2F%3Fx",
    );
    expect(ebay.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("fails with a typed error that names only the status when the key id is unknown", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [{ errorId: 195000 }] }, { status: 404 }));
    const client = keyClient(ebay);

    const error = await client.getKey("kid-sentinel").catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "client_error", operation: "public_key", status: 404, errorIds: [195000] });
    expect((error as Error).message).toBe("eBay public_key failed: client_error (HTTP 404)");
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("kid-sentinel");
    expect(ebay.keyCalls()).toHaveLength(1);
  });

  it("reuses a key for one hour and fetches it again after that", async () => {
    const ebay = fakeEbay();
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await client.getKey("kid-1");
    now.value = 59 * 60_000;
    await client.getKey("kid-1");
    expect(ebay.keyCalls()).toHaveLength(1);

    now.value = 61 * 60_000;
    await client.getKey("kid-1");
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("does not ask eBay again for a key id that failed less than a minute ago", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [] }, { status: 404 }));
    const now = { value: 0 };
    const client = keyClient(ebay, now);

    await expect(client.getKey("unknown")).rejects.toThrow();
    now.value = 59_000;
    await expect(client.getKey("unknown")).rejects.toThrow();
    expect(ebay.keyCalls()).toHaveLength(1);

    now.value = 61_000;
    await expect(client.getKey("unknown")).rejects.toThrow();
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("forgets the oldest failed key ids beyond 1,000 so random ids cannot exhaust memory", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [] }, { status: 404 }));
    const client = keyClient(ebay);
    const requested = () => ebay.keyCalls().map((c) => c.url);

    for (let i = 0; i <= 1000; i++) await client.getKey(`kid-${i}`).catch(() => undefined);
    await client.getKey("kid-0").catch(() => undefined);
    await client.getKey("kid-1000").catch(() => undefined);

    expect(requested().filter((u) => u.endsWith("/kid-0"))).toHaveLength(2);
    expect(requested().filter((u) => u.endsWith("/kid-1000"))).toHaveLength(1);
  });

  it("shares one eBay request between concurrent lookups of the same key id", async () => {
    const ebay = fakeEbay();
    const client = keyClient(ebay);

    await Promise.all([client.getKey("kid-1"), client.getKey("kid-1"), client.getKey("kid-1")]);

    expect(ebay.keyCalls()).toHaveLength(1);
    expect(ebay.tokenRequests()).toBe(1);
  });

  it("retries a 503 once and returns the key", async () => {
    const ebay = fakeEbay((_url, n) => (n === 1 ? new Response("busy", { status: 503 }) : keyResponse()));
    const client = keyClient(ebay);

    await expect(client.getKey("kid-1")).resolves.toBe(PEM);
    expect(ebay.keyCalls()).toHaveLength(2);
  });

  it("refreshes the token once after a 401", async () => {
    const ebay = fakeEbay((_url, n) => (n === 1 ? Response.json({ errors: [] }, { status: 401 }) : keyResponse()));
    const client = keyClient(ebay);

    await expect(client.getKey("kid-1")).resolves.toBe(PEM);
    expect(ebay.tokenRequests()).toBe(2);
    expect(new Headers(ebay.keyCalls()[1]?.init?.headers).get("authorization")).toBe("Bearer app-token-2");
  });

  it("has no reservation step, because key lookups use the Notification API pool (ADR 0013)", () => {
    expectTypeOf<PublicKeyClientOptions>().not.toHaveProperty("reserve");
    expect(Object.keys(keyClient(fakeEbay()))).toEqual(["getKey"]);
  });
});

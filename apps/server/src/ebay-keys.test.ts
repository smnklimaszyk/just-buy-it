import { describe, expect, it } from "vitest";
import { createPublicKeyClient } from "./ebay-keys.js";

type Call = { url: string; init: RequestInit | undefined };

function fakeEbay() {
  const calls: Call[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/identity/v1/oauth2/token")) {
      return Response.json({ access_token: "app-token", expires_in: 7200, token_type: "Application Access Token" });
    }
    return Response.json({ key: "-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----", algorithm: "ECDSA", digest: "SHA1" });
  };
  return { calls, fetchFn };
}

describe("createPublicKeyClient", () => {
  it("gets an application token with client credentials, then the public key for the key id", async () => {
    const ebay = fakeEbay();
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      now: () => 0,
    });

    const key = await client.getKey("kid-1");

    expect(key).toBe("-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----");
    expect(ebay.calls.map((c) => c.url)).toEqual([
      "https://api.ebay.com/identity/v1/oauth2/token",
      "https://api.ebay.com/commerce/notification/v1/public_key/kid-1",
    ]);
    const tokenHeaders = new Headers(ebay.calls[0]?.init?.headers);
    expect(tokenHeaders.get("authorization")).toBe(`Basic ${Buffer.from("app-id:cert-id").toString("base64")}`);
    expect(String(ebay.calls[0]?.init?.body)).toBe(
      "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    );
    expect(new Headers(ebay.calls[1]?.init?.headers).get("authorization")).toBe("Bearer app-token");
  });

  it("reuses the application token until five minutes before it expires", async () => {
    const ebay = fakeEbay();
    let nowMs = 0;
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      now: () => nowMs,
    });
    const tokenCalls = () => ebay.calls.filter((c) => c.url.endsWith("/oauth2/token")).length;

    await client.getKey("kid-1");
    nowMs = 114 * 60_000;
    await client.getKey("kid-2");
    expect(tokenCalls()).toBe(1);

    nowMs = 116 * 60_000;
    await client.getKey("kid-3");
    expect(tokenCalls()).toBe(2);
  });

  it("sends every request with a timeout signal", async () => {
    const ebay = fakeEbay();
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      now: () => 0,
    });

    await client.getKey("kid-1");

    expect(ebay.calls.every((c) => c.init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("fails with the HTTP status when eBay rejects the credentials", async () => {
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "wrong",
      fetchFn: async () => Response.json({ error: "invalid_client" }, { status: 401 }),
      now: () => 0,
    });

    await expect(client.getKey("kid-1")).rejects.toThrow("eBay token request failed with status 401");
  });

  it("fails with the HTTP status when the key id is unknown", async () => {
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: async (input: string | URL | Request) =>
        String(input).endsWith("/oauth2/token")
          ? Response.json({ access_token: "app-token", expires_in: 7200 })
          : Response.json({ errors: [] }, { status: 404 }),
      now: () => 0,
    });

    await expect(client.getKey("kid-x")).rejects.toThrow("eBay public key request failed with status 404");
  });

  it("does not ask eBay again for a key id that failed less than a minute ago", async () => {
    let keyRequests = 0;
    let nowMs = 0;
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: async (input: string | URL | Request) => {
        if (String(input).endsWith("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
        keyRequests += 1;
        return Response.json({ errors: [] }, { status: 404 });
      },
      now: () => nowMs,
    });

    await expect(client.getKey("unknown")).rejects.toThrow();
    nowMs = 59_000;
    await expect(client.getKey("unknown")).rejects.toThrow();
    expect(keyRequests).toBe(1);

    nowMs = 61_000;
    await expect(client.getKey("unknown")).rejects.toThrow();
    expect(keyRequests).toBe(2);
  });

  it("forgets the oldest failed key ids beyond 1,000 so random ids cannot exhaust memory", async () => {
    const requested: string[] = [];
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/oauth2/token")) return Response.json({ access_token: "t", expires_in: 7200 });
        requested.push(url);
        return Response.json({ errors: [] }, { status: 404 });
      },
      now: () => 0,
    });

    for (let i = 0; i <= 1000; i++) await client.getKey(`kid-${i}`).catch(() => undefined);
    await client.getKey("kid-0").catch(() => undefined);
    await client.getKey("kid-1000").catch(() => undefined);

    expect(requested.filter((u) => u.endsWith("/kid-0"))).toHaveLength(2);
    expect(requested.filter((u) => u.endsWith("/kid-1000"))).toHaveLength(1);
  });

  it("shares one eBay request between concurrent lookups of the same key id", async () => {
    const ebay = fakeEbay();
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      now: () => 0,
    });

    await Promise.all([client.getKey("kid-1"), client.getKey("kid-1"), client.getKey("kid-1")]);

    expect(ebay.calls.filter((c) => c.url.includes("/public_key/"))).toHaveLength(1);
    expect(ebay.calls.filter((c) => c.url.endsWith("/oauth2/token"))).toHaveLength(1);
  });

  it("reuses a key for one hour and fetches it again after that", async () => {
    const ebay = fakeEbay();
    let nowMs = 0;
    const client = createPublicKeyClient({
      apiBase: "https://api.ebay.com",
      clientId: "app-id",
      clientSecret: "cert-id",
      fetchFn: ebay.fetchFn,
      now: () => nowMs,
    });
    const keyCalls = () => ebay.calls.filter((c) => c.url.includes("/public_key/")).length;

    await client.getKey("kid-1");
    nowMs = 59 * 60_000;
    await client.getKey("kid-1");
    expect(keyCalls()).toBe(1);

    nowMs = 61 * 60_000;
    await client.getKey("kid-1");
    expect(keyCalls()).toBe(2);
  });
});

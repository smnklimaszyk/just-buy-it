import type { FetchFn } from "@ebay-sniper/ebay";
import { describe, expect, it, vi } from "vitest";
import { createKeyLookup } from "./ebay-wiring.js";

const clock = { now: () => new Date("2026-10-20T10:00:00Z") };
const apiBase = "https://api.ebay.test";

describe("createKeyLookup", () => {
  it("answers unavailable without eBay credentials and makes no request", async () => {
    const fetchFn = vi.fn<FetchFn>();
    const countRequest = vi.fn();
    const lookupKey = createKeyLookup({ apiBase, credentials: undefined, fetchFn, clock, countRequest });

    const lookup = await lookupKey("kid-1");

    // Not "unauthorized": nothing was sent, so the log line must not read like eBay refused us.
    expect(lookup.kind === "unavailable" && lookup.error.kind).toBe("not_configured");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(countRequest).not.toHaveBeenCalled();
  });

  it("ends a lookup whose token request hangs as unavailable after about 5 s (real time)", { timeout: 10_000 }, async () => {
    // Like the real fetch: never answers, rejects when the request signal aborts.
    const fetchFn = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const lookupKey = createKeyLookup({
      apiBase,
      credentials: { clientId: "app-id", clientSecret: "cert-id" },
      fetchFn,
      clock,
      countRequest: () => undefined,
    });

    const started = performance.now();
    const lookup = await lookupKey("kid-1");
    const elapsedMs = performance.now() - started;

    expect(lookup.kind === "unavailable" && lookup.error.kind).toBe("timeout");
    expect(elapsedMs).toBeGreaterThanOrEqual(4_800);
    expect(elapsedMs).toBeLessThan(6_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("counts one token request and one key request under their api_usage_hourly names", async () => {
    const fetchFn = vi.fn<FetchFn>(async (url) =>
      String(url).endsWith("/identity/v1/oauth2/token")
        ? Response.json({ access_token: "app-token", expires_in: 7200 })
        : Response.json({ key: "-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----" }),
    );
    const counted: string[] = [];
    const lookupKey = createKeyLookup({
      apiBase,
      credentials: { clientId: "app-id", clientSecret: "cert-id" },
      fetchFn,
      clock,
      countRequest: (resource, purpose) => counted.push(`${resource}/${purpose}`),
    });

    const lookup = await lookupKey("kid-1");

    expect(lookup).toEqual({ kind: "key", key: "-----BEGIN PUBLIC KEY-----abc-----END PUBLIC KEY-----", stale: false });
    expect(counted).toEqual(["identity.oauth2/token", "commerce.notification/deletion-key"]);
    expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
      `${apiBase}/identity/v1/oauth2/token`,
      `${apiBase}/commerce/notification/v1/public_key/kid-1`,
    ]);
  });
});

import { createPublicKeyClient, type FetchFn } from "@ebay-sniper/ebay";
import { describe, expect, it, vi } from "vitest";
import { createApp, type IncomingNotification } from "./app.js";
import { challengeResponse } from "./deletion.js";
import { createDeletionQueue } from "./deletion-queue.js";
import { createNotificationWork } from "./notifications.js";
import { createProbeRecorder } from "./probe.js";
import { createSigner, notificationBody } from "./testing/signed.js";

const endpointUrl = "https://deals.intra-ai.de/ebay/account-deletion";
const verificationToken = "t".repeat(64);
const gitSha = "0123456789abcdef0123456789abcdef01234567";
const probeCode = "probe_code-0123456789abcdefghijABCDEFGHI";
const base = { endpointUrl, verificationToken, gitSha, probeCode, onProbe: () => undefined };
const fixedClock = { now: () => new Date("2026-10-20T10:00:30Z") };

describe("GET /healthz", () => {
  it("reports the running commit and is never cached", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(`{"sha":"${gitSha}"}`);
  });
});

describe("GET /privacy", () => {
  it("serves the privacy notice as HTML", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/privacy");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("Intra AI");
  });

  it("names info@intra-ai.de as the contact", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/privacy");

    expect(await res.text()).toContain("info@intra-ai.de");
  });

  it("sends a strict content security policy and nosniff", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/privacy");

    expect(res.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const deletion = await app.request("/ebay/account-deletion?challenge_code=abc");
    expect(deletion.headers.get("content-security-policy")).toBeNull();
  });
});

describe("GET /ebay/account-deletion", () => {
  it("answers eBay's challenge with the hash as JSON", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/ebay/account-deletion?challenge_code=abc123");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ challengeResponse: challengeResponse("abc123", verificationToken, endpointUrl) });
  });

  it("answers the probe code like any other code, never cached, and reports the probe", async () => {
    const onProbe = vi.fn();
    const app = createApp({ endpointUrl, verificationToken, gitSha, probeCode, onProbe, onNotification: () => undefined });

    const res = await app.request(`/ebay/account-deletion?challenge_code=${probeCode}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ challengeResponse: challengeResponse(probeCode, verificationToken, endpointUrl) });
    expect(onProbe).toHaveBeenCalledTimes(1);
  });

  it.each(["abc123", probeCode.slice(0, 39), `${probeCode}x`, probeCode.toUpperCase()])(
    "does not report a probe for another code: %s",
    async (code) => {
      const onProbe = vi.fn();
      const app = createApp({ ...base, onProbe, onNotification: () => undefined });

      const res = await app.request(`/ebay/account-deletion?challenge_code=${encodeURIComponent(code)}`);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(onProbe).not.toHaveBeenCalled();
    },
  );

  it("writes probe_seen once for 100 probes in one minute", async () => {
    const record = vi.fn(async () => undefined);
    const recorder = createProbeRecorder({ clock: fixedClock, record, log: { warn: () => undefined } });
    const app = createApp({ ...base, onProbe: recorder.seen, onNotification: () => undefined });

    for (let i = 0; i < 100; i += 1) await app.request(`/ebay/account-deletion?challenge_code=${probeCode}`);

    expect(record).toHaveBeenCalledTimes(1);
  });

  it("still answers the probe with the right hash when probe_seen cannot be written", async () => {
    const lines: Record<string, unknown>[] = [];
    const recorder = createProbeRecorder({
      clock: fixedClock,
      record: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      log: { warn: (entry) => lines.push(entry) },
    });
    const app = createApp({ ...base, onProbe: recorder.seen, onNotification: () => undefined });

    const res = await app.request(`/ebay/account-deletion?challenge_code=${probeCode}`);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeResponse: challengeResponse(probeCode, verificationToken, endpointUrl) });
    expect(lines).toEqual([{ event: "probe_seen_unsaved" }]);
    expect(JSON.stringify(lines)).not.toContain(probeCode);
  });

  it("rejects a GET without challenge_code with 400", async () => {
    const app = createApp({ ...base, onNotification: () => undefined });

    const res = await app.request("/ebay/account-deletion");

    expect(res.status).toBe(400);
  });
});

describe("other methods on /ebay/account-deletion", () => {
  it.each(["PUT", "DELETE", "PATCH"])("answers %s with 405 and the allowed methods", async (method) => {
    const received: IncomingNotification[] = [];
    const app = createApp({ ...base, onNotification: (n) => received.push(n) });

    const res = await app.request("/ebay/account-deletion", { method, body: "{}" });

    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST");
    // A body gives the reply a Content-Length; Traefik's buffering middleware answers 500 to an
    // empty chunked reply.
    expect(await res.text()).toBe("Method Not Allowed");
    expect(received).toEqual([]);
  });
});

describe("POST /ebay/account-deletion", () => {
  it("acknowledges with 204 and passes the raw body and signature header on", async () => {
    const received: IncomingNotification[] = [];
    const app = createApp({ ...base, onNotification: (n) => received.push(n) });
    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" } });

    const res = await app.request("/ebay/account-deletion", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ebay-signature": "sig-header" },
      body,
    });

    expect(res.status).toBe(204);
    expect(received).toEqual([{ rawBody: body, signatureHeader: "sig-header" }]);
  });

  it("refuses bodies over 64 KB with 413 and does not pass them on", async () => {
    const received: IncomingNotification[] = [];
    const app = createApp({ ...base, onNotification: (n) => received.push(n) });

    const res = await app.request("/ebay/account-deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1024 + 1),
    });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });

  it("returns 204 within 1 s, before the key fetch starts, while the key fetch hangs (A2)", async () => {
    const fetchFn = vi.fn<FetchFn>(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const { lookupKey } = createPublicKeyClient({
      apiBase: "https://api.ebay.test",
      token: { get: async () => "app-token", invalidate: () => undefined },
      fetchFn,
      clock: fixedClock,
      timeoutMs: 60_000,
    });
    const queue = createDeletionQueue<IncomingNotification>({
      capacity: 1_000,
      concurrency: 4,
      work: createNotificationWork({
        lookupKey,
        countResult: () => undefined,
        recordVerified: async () => "inserted",
        log: { info: () => undefined, warn: () => undefined },
        clock: fixedClock,
      }),
      onDropped: () => undefined,
      onError: () => undefined,
    });
    const app = createApp({ ...base, onNotification: queue.push });
    const notification = createSigner("kid-a2").signed(notificationBody());

    const started = performance.now();
    const res = await app.request("/ebay/account-deletion", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ebay-signature": notification.signatureHeader ?? "" },
      body: notification.rawBody,
    });
    const elapsedMs = performance.now() - started;

    expect(res.status).toBe(204);
    expect(elapsedMs).toBeLessThan(1_000);
    expect(fetchFn).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://api.ebay.test/commerce/notification/v1/public_key/kid-a2");
    await queue.drain(0);
  });
});

import { describe, expect, it } from "vitest";
import { createApp, type IncomingNotification } from "./app.js";
import { challengeResponse } from "./deletion.js";

const endpointUrl = "https://deals.intra-ai.de/ebay/account-deletion";
const verificationToken = "t".repeat(64);

describe("GET /healthz", () => {
  it("reports ok without touching anything else", async () => {
    const app = createApp({ endpointUrl, verificationToken, onNotification: () => undefined });

    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /privacy", () => {
  it("serves the privacy notice as HTML", async () => {
    const app = createApp({ endpointUrl, verificationToken, onNotification: () => undefined });

    const res = await app.request("/privacy");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("Intra AI");
  });
});

describe("GET /ebay/account-deletion", () => {
  it("answers eBay's challenge with the hash as JSON", async () => {
    const app = createApp({ endpointUrl, verificationToken, onNotification: () => undefined });

    const res = await app.request("/ebay/account-deletion?challenge_code=abc123");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ challengeResponse: challengeResponse("abc123", verificationToken, endpointUrl) });
  });

  it("rejects a GET without challenge_code with 400", async () => {
    const app = createApp({ endpointUrl, verificationToken, onNotification: () => undefined });

    const res = await app.request("/ebay/account-deletion");

    expect(res.status).toBe(400);
  });
});

describe("POST /ebay/account-deletion", () => {
  it("acknowledges with 204 and passes the raw body and signature header on", async () => {
    const received: IncomingNotification[] = [];
    const app = createApp({ endpointUrl, verificationToken, onNotification: (n) => received.push(n) });
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
    const app = createApp({ endpointUrl, verificationToken, onNotification: (n) => received.push(n) });

    const res = await app.request("/ebay/account-deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(64 * 1024 + 1),
    });

    expect(res.status).toBe(413);
    expect(received).toEqual([]);
  });
});

import { createClaudeScreener } from "@ebay-sniper/llm";
import { createSmtpMailer } from "@ebay-sniper/notify";
import { describe, expect, it } from "vitest";
import { CLAUDE_TEST_KEY, createFakeClaude } from "./claude.js";
import { createTestClock } from "./clock.js";
import { createFakeEbay, createFakeReserve, testGetItem } from "./ebay.js";
import { createFakeSmtp, SMTP_TEST_PASSWORD } from "./smtp.js";

// The fakes stand in for Anthropic and the SMTP server in the worker tests, so they must answer
// in the shapes the real adapters read.

describe("fake Claude", () => {
  it("answers with a Messages API body the adapter parses, and keeps the request it got", async () => {
    const claude = createFakeClaude();
    claude.answer({ verdict: "caution", product_match: "match", risk_flags: ["mining_history"], reason: "Used for mining." });
    const screener = createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn });

    const result = await screener.screen("<listing>{}</listing>");

    expect(result.answer).toEqual({
      verdict: "caution",
      productMatch: "match",
      riskFlags: ["mining_history"],
      reason: "Used for mining.",
    });
    expect(result.model).toBe("claude-sonnet-5-5");
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 800 });
    expect(claude.requests).toHaveLength(1);
    expect(claude.requests[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 3000 });
    expect(claude.requests[0]?.headers["x-api-key"]).toBe(CLAUDE_TEST_KEY);
  });

  it("answers an HTTP error and hangs until the deadline, as the adapter's failure codes expect", async () => {
    const claude = createFakeClaude();
    claude.status(401, { error: { message: `invalid x-api-key ${CLAUDE_TEST_KEY}` } });
    claude.hang();
    const screener = createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn });

    await expect(screener.screen("<listing>{}</listing>")).rejects.toMatchObject({ code: "auth_failed", status: 401 });
    await expect(screener.screen("<listing>{}</listing>", AbortSignal.timeout(50))).rejects.toMatchObject({ code: "timeout" });
  });
});

describe("fake eBay", () => {
  it("answers getItem for a registered item through the real item client, 404 otherwise, each attempt reserved", async () => {
    const ebay = createFakeEbay();
    const reserve = createFakeReserve();
    ebay.item("v1|955500000700|0", { itemId: "v1|955500000700|0", legacyItemId: "955500000700", title: "RTX 3090" });
    const getItem = testGetItem(ebay, createTestClock(new Date("2026-10-21T10:00:00.000Z")))(reserve.reserve);
    const call = { callClass: "alert-path" as const, purpose: "enrich", minLeft: 100 };

    expect(await getItem("v1|955500000700|0", {}, call)).toMatchObject({ status: "found", item: { title: "RTX 3090" } });
    expect(await getItem("v1|955500000701|0", {}, call)).toEqual({ status: "not_found" });
    expect(reserve.reservations).toHaveLength(2);
  });
});

describe("fake SMTP", () => {
  const config = {
    host: "smtp.test",
    port: 587,
    user: "alerts@example.test",
    password: SMTP_TEST_PASSWORD,
    from: { name: "Just-Buy-It", address: "alerts@example.test" },
  };
  const email = { deliveryId: "0199f0a2-7c1e-7b3a-9d4e-2f6a8b0c1d2e", to: "owner@example.test", subject: "s", text: "t", html: "h" };

  it("accepts with 250, then replies with the queued failures the adapter maps to its error kinds", async () => {
    const smtp = createFakeSmtp();
    smtp.reply("accept", 421, 550, "auth");
    const mailer = createSmtpMailer(config, smtp.createTransport);

    expect(await mailer.send(email)).toEqual({ messageId: "<fake-1@smtp.test>", responseCode: 250 });
    await expect(mailer.send(email)).rejects.toMatchObject({ kind: "transient", responseCode: 421 });
    await expect(mailer.send(email)).rejects.toMatchObject({ kind: "failed", responseCode: 550 });
    await expect(mailer.send(email)).rejects.toMatchObject({ kind: "auth", code: "EAUTH" });
    expect(smtp.sent.map((m) => m.headers)).toEqual(Array.from({ length: 4 }, () => ({ "X-Delivery-Id": email.deliveryId })));
    expect(smtp.transportOptions[0]).toMatchObject({ host: "smtp.test", port: 587, requireTLS: true });
  });
});

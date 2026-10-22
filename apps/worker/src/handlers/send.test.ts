import { insertAlert, insertAlertMessage, insertDelivery } from "@ebay-sniper/db";
import { createSmtpMailer } from "@ebay-sniper/notify";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createTestLog } from "../testing/log.js";
import { resetTables } from "../testing/queue.js";
import { createFakeSmtp, SMTP_TEST_PASSWORD } from "../testing/smtp.js";
import { createSendHandler, type SendDeps } from "./send.js";

// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const RECIPIENT = "owner@example.test";
const SMTP_CONFIG = {
  host: "smtp.test",
  port: 587,
  user: "alerts@example.test",
  password: SMTP_TEST_PASSWORD,
  from: { name: "Just-Buy-It", address: "alerts@example.test" },
};

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await resetTables(db);
});

// A pending delivery with its rendered message, as the alert transaction leaves it.
async function arrangeDelivery(fields: { message?: boolean } = {}): Promise<string> {
  const alert = await insertAlert(db.admin, {
    itemKey: randomUUID().replaceAll("-", ""),
    candidateId: randomUUID(),
    screeningId: null,
    segment: "gpu_3090",
    finalVerdict: "pass",
    modelVerdict: "pass",
    blockedByCode: false,
    screened: true,
    flags: [],
    priceCents: 45000,
    shippingCents: 1000,
    landedCents: 46000,
    ruleVersion: 1,
    buyerProfile: "company",
    createdAt: new Date(NOW.getTime() - 60_000),
  });
  const deliveryId = await insertDelivery(db.admin, { alertId: alert.id, recipient: RECIPIENT, now: new Date(NOW.getTime() - 60_000) });
  if (fields.message ?? true) {
    await insertAlertMessage(db.admin, {
      deliveryId,
      subject: "[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - PASS",
      textBody: "text body",
      htmlBody: "<p>html body</p>",
      expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
  }
  return deliveryId;
}

function setup(overrides: Partial<SendDeps> = {}) {
  const clock = createTestClock(NOW);
  const log = createTestLog();
  const smtp = createFakeSmtp();
  const deps: SendDeps = {
    pool: db.pool,
    clock,
    mailer: createSmtpMailer(SMTP_CONFIG, smtp.createTransport),
    log: log.log,
    ...overrides,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, log, smtp, deps, send: createSendHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

describe("send, accepted (sections 2.4, 6.5)", () => {
  it("claims the delivery, sends its message to the recipient and marks it sent with attempt 1", async () => {
    const deliveryId = await arrangeDelivery();
    const { smtp, send, job } = setup();

    await send({ deliveryId }, job());

    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({
      to: RECIPIENT,
      subject: "[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - PASS",
      text: "text body",
      html: "<p>html body</p>",
      headers: { "X-Delivery-Id": deliveryId },
    });
    expect(
      await rows("SELECT status, attempt, sent_at, smtp_message_id, lease_until, hold_reason FROM app.alert_delivery"),
    ).toEqual([{ status: "sent", attempt: 1, sent_at: NOW, smtp_message_id: "<fake-1@smtp.test>", lease_until: null, hold_reason: null }]);
  });

  it("logs the sent delivery with the SMTP reply code", async () => {
    const deliveryId = await arrangeDelivery();
    const { send, job, log } = setup();

    await send({ deliveryId }, job());

    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "sent", hold_reason: null, attempt: 1, smtp_code: 250 },
    ]);
  });
});

describe("send gates before the claim (sections 2.4, 6.4, 6.5)", () => {
  it("holds the delivery for 5 minutes with smtp_not_configured, attempt unchanged, and logs one line", async () => {
    const deliveryId = await arrangeDelivery();
    const { deps, job, log } = setup();
    const send = createSendHandler({ ...deps, mailer: null });

    await send({ deliveryId }, job());

    expect(await rows("SELECT status, attempt, hold_reason, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 0, hold_reason: "smtp_not_configured", next_attempt_at: new Date(NOW.getTime() + 5 * 60_000) },
    ]);
    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "pending", hold_reason: "smtp_not_configured", attempt: 0, smtp_code: null },
    ]);
  });

  it("holds the delivery until the pause ends while SMTP is paused after EAUTH", async () => {
    const deliveryId = await arrangeDelivery();
    const pauseEnd = new Date(NOW.getTime() + 10 * 60_000);
    await db.admin.query("INSERT INTO app.smtp_pause (id, until) VALUES (1, $1)", [pauseEnd]);
    const { smtp, send, job } = setup();

    await send({ deliveryId }, job());

    expect(smtp.sent).toEqual([]);
    expect(await rows("SELECT status, attempt, hold_reason, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 0, hold_reason: "smtp_paused", next_attempt_at: pauseEnd },
    ]);
  });

  it("expires a delivery whose message is gone, and never sends it", async () => {
    const deliveryId = await arrangeDelivery({ message: false });
    const { smtp, send, job, log } = setup();

    await send({ deliveryId }, job());

    expect(smtp.sent).toEqual([]);
    expect(await rows("SELECT status, attempt FROM app.alert_delivery")).toEqual([{ status: "expired", attempt: 0 }]);
    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "expired", hold_reason: null, attempt: 0, smtp_code: null },
    ]);
  });

  it("holds the 11th email of the rolling hour with rate_limit until the oldest counted send leaves the window", async () => {
    // Ten sent in the last hour, the oldest 50 minutes ago.
    for (let i = 0; i < 10; i += 1) {
      const sentId = await arrangeDelivery();
      await db.admin.query("UPDATE app.alert_delivery SET status = 'sent', attempt = 1, sent_at = $2 WHERE id = $1", [
        sentId,
        new Date(NOW.getTime() - (50 - i) * 60_000),
      ]);
    }
    const deliveryId = await arrangeDelivery();
    const { smtp, send, job } = setup();

    await send({ deliveryId }, job());

    expect(smtp.sent).toEqual([]);
    expect(await rows("SELECT status, attempt, hold_reason, next_attempt_at FROM app.alert_delivery WHERE id = $1", [deliveryId])).toEqual([
      { status: "pending", attempt: 0, hold_reason: "rate_limit", next_attempt_at: new Date(NOW.getTime() + 10 * 60_000) },
    ]);
  });

  it("leaves a delivery that is not due yet as it is, so a gate never shortens its backoff", async () => {
    const deliveryId = await arrangeDelivery();
    const backoffEnd = new Date(NOW.getTime() + 30 * 60_000);
    await db.admin.query("UPDATE app.alert_delivery SET attempt = 3, next_attempt_at = $2, last_error_code = 'ETIMEDOUT' WHERE id = $1", [
      deliveryId,
      backoffEnd,
    ]);
    const { deps, job, log } = setup();
    const send = createSendHandler({ ...deps, mailer: null });

    await send({ deliveryId }, job());

    expect(await rows("SELECT status, attempt, hold_reason, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 3, hold_reason: null, next_attempt_at: backoffEnd },
    ]);
    expect(log.events("delivery")).toEqual([]);
  });
});

describe("send gates for a sending delivery whose lease ran out (section 2.4)", () => {
  const lostSend = async (fields: { message?: boolean } = {}) => {
    const deliveryId = await arrangeDelivery(fields);
    await db.admin.query(
      "UPDATE app.alert_delivery SET status = 'sending', attempt = 1, lease_until = $2 WHERE id = $1",
      [deliveryId, new Date(NOW.getTime() - 1000)],
    );
    return deliveryId;
  };

  it("holds it back to pending while SMTP is not configured, so relay stops queueing it every minute", async () => {
    const deliveryId = await lostSend();
    const { send, job } = setup({ mailer: null });

    await send({ deliveryId }, job());

    expect(await rows("SELECT status, hold_reason, attempt, lease_until, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", hold_reason: "smtp_not_configured", attempt: 1, lease_until: null, next_attempt_at: new Date(NOW.getTime() + 5 * 60_000) },
    ]);
  });

  it("expires it when its message is gone", async () => {
    const deliveryId = await lostSend({ message: false });
    const { smtp, send, job } = setup();

    await send({ deliveryId }, job());

    expect(smtp.sent).toEqual([]);
    expect(await rows("SELECT status, attempt FROM app.alert_delivery")).toEqual([{ status: "expired", attempt: 1 }]);
  });
});

describe("send, SMTP failures (sections 2.4, 6.5)", () => {
  it("puts a transient failure back to pending with the backoff for relay, attempt counted", async () => {
    const deliveryId = await arrangeDelivery();
    const { smtp, send, job, log } = setup();
    smtp.reply(421);

    await send({ deliveryId }, job());

    expect(await rows("SELECT status, attempt, last_error_code, next_attempt_at, lease_until FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 1, last_error_code: "EENVELOPE", next_attempt_at: new Date(NOW.getTime() + 60_000), lease_until: null },
    ]);
    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "pending", hold_reason: null, attempt: 1, smtp_code: 421 },
    ]);
  });

  it("fails a delivery on a permanent 5xx such as 550", async () => {
    const deliveryId = await arrangeDelivery();
    const { smtp, send, job, log } = setup();
    smtp.reply(550);

    await send({ deliveryId }, job());

    expect(await rows("SELECT status, attempt, last_error_code, lease_until FROM app.alert_delivery")).toEqual([
      { status: "failed", attempt: 1, last_error_code: "EENVELOPE", lease_until: null },
    ]);
    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "failed", hold_reason: null, attempt: 1, smtp_code: 550 },
    ]);
  });

  it("pauses all sends for 15 minutes on EAUTH, keeps the delivery pending to the pause end, and logs it once", async () => {
    const deliveryId = await arrangeDelivery();
    const { smtp, send, job, log } = setup();
    smtp.reply("auth");
    const pauseEnd = new Date(NOW.getTime() + 15 * 60_000);

    await send({ deliveryId }, job());

    expect(await rows("SELECT until FROM app.smtp_pause")).toEqual([{ until: pauseEnd }]);
    expect(await rows("SELECT status, attempt, last_error_code, next_attempt_at FROM app.alert_delivery")).toEqual([
      { status: "pending", attempt: 1, last_error_code: "EAUTH", next_attempt_at: pauseEnd },
    ]);
    expect(log.events("smtp_paused")).toEqual([{ event: "smtp_paused", until: pauseEnd.toISOString() }]);
    expect(log.text()).not.toContain(SMTP_TEST_PASSWORD);
  });
});

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  claimDelivery,
  deliveriesDue,
  expireDelivery,
  failDelivery,
  failLostDeliveries,
  getDeliveryForSend,
  holdDelivery,
  insertAlertMessage,
  insertDelivery,
  markDeliverySent,
  pauseSmtp,
  scheduleDeliveryRetry,
  sendTimesSince,
  smtpPausedUntil,
} from "./delivery.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const T0 = new Date("2026-10-21T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const alertId = (n: number) => `00000000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const RECIPIENT = "owner@example.test";

const message = (deliveryId: string) => ({
  deliveryId,
  subject: "[Deal] RTX 3090: EUR 489 incl. shipping (94% of max) - PASS",
  textBody: "text",
  htmlBody: "<p>html</p>",
  expiresAt: at(6 * 3600),
});

describe("insertDelivery, insertAlertMessage and getDeliveryForSend", () => {
  it("makes one pending delivery per alert and recipient with attempt 0, and reads it with its message", async () => {
    const id = await insertDelivery(database.pool, { alertId: alertId(1), recipient: RECIPIENT, now: at(0) });
    const repeat = await insertDelivery(database.pool, { alertId: alertId(1), recipient: RECIPIENT, now: at(5) });
    await insertAlertMessage(database.pool, message(id));
    const other = await insertDelivery(database.pool, { alertId: alertId(2), recipient: RECIPIENT, now: at(0) });

    expect(repeat).toBe(id);
    expect(await getDeliveryForSend(database.pool, id)).toEqual({
      id,
      alertId: alertId(1),
      recipient: RECIPIENT,
      status: "pending",
      holdReason: null,
      attempt: 0,
      nextAttemptAt: at(0),
      leaseUntil: null,
      message: { subject: message(id).subject, textBody: "text", htmlBody: "<p>html</p>" },
    });
    expect(await getDeliveryForSend(database.pool, other)).toMatchObject({ status: "pending", message: null });
    expect(await getDeliveryForSend(database.pool, alertId(9))).toBeNull();
  });
});

describe("holdDelivery and claimDelivery", () => {
  it("holds without touching attempt, and claims only when next_attempt_at is due or a lease ran out", async () => {
    const id = await insertDelivery(database.pool, { alertId: alertId(10), recipient: RECIPIENT, now: at(0) });

    for (const holdReason of ["smtp_not_configured", "smtp_paused", "rate_limit"] as const) {
      expect(await holdDelivery(database.pool, id, { holdReason, nextAttemptAt: at(300), now: at(1) })).toBe(true);
    }
    const held = await getDeliveryForSend(database.pool, id);
    const early = await claimDelivery(database.pool, id, at(299));
    const claimed = await claimDelivery(database.pool, id, at(300));
    const whileLeased = await claimDelivery(database.pool, id, at(359));
    const afterLease = await claimDelivery(database.pool, id, at(361));

    expect(held).toMatchObject({ status: "pending", holdReason: "rate_limit", attempt: 0, nextAttemptAt: at(300) });
    expect([early, claimed, whileLeased, afterLease]).toEqual([null, 1, null, 2]);
    expect(await getDeliveryForSend(database.pool, id)).toMatchObject({
      status: "sending",
      holdReason: null,
      attempt: 2,
      leaseUntil: at(421),
    });
    expect(await holdDelivery(database.pool, id, { holdReason: "rate_limit", nextAttemptAt: at(900), now: at(400) })).toBe(false);
    // A sending row whose lease ran out (the worker died mid-send) is held back to pending.
    expect(await holdDelivery(database.pool, id, { holdReason: "smtp_not_configured", nextAttemptAt: at(900), now: at(422) })).toBe(true);
    expect(await getDeliveryForSend(database.pool, id)).toMatchObject({
      status: "pending",
      holdReason: "smtp_not_configured",
      attempt: 2,
      nextAttemptAt: at(900),
      leaseUntil: null,
    });
  });
});

describe("send results", () => {
  it("writes sent fenced on the attempt, retries with backoff, fails at attempt 5, and expires a pending delivery", async () => {
    const sent = await insertDelivery(database.pool, { alertId: alertId(20), recipient: RECIPIENT, now: at(0) });
    await claimDelivery(database.pool, sent, at(0));
    expect(await markDeliverySent(database.pool, sent, 2, { smtpMessageId: "<a@b>", now: at(1) })).toBe(false);
    expect(await markDeliverySent(database.pool, sent, 1, { smtpMessageId: "<a@b>", now: at(1) })).toBe(true);
    expect(await getDeliveryForSend(database.pool, sent)).toMatchObject({ status: "sent", attempt: 1, leaseUntil: null });

    const retried = await insertDelivery(database.pool, { alertId: alertId(21), recipient: RECIPIENT, now: at(0) });
    const delays: (number | null)[] = [];
    let now = at(0);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await claimDelivery(database.pool, retried, now)).toBe(attempt);
      expect(await scheduleDeliveryRetry(database.pool, retried, attempt, { lastErrorCode: "421", now })).toBe(true);
      const row = await getDeliveryForSend(database.pool, retried);
      delays.push(row?.status === "pending" ? (row.nextAttemptAt.getTime() - now.getTime()) / 60_000 : null);
      now = row?.nextAttemptAt ?? now;
    }
    expect(delays).toEqual([1, 5, 15, 30, null]);
    expect(await getDeliveryForSend(database.pool, retried)).toMatchObject({ status: "failed", attempt: 5 });
    expect(await claimDelivery(database.pool, retried, at(99_999))).toBeNull();

    const refused = await insertDelivery(database.pool, { alertId: alertId(22), recipient: RECIPIENT, now: at(0) });
    await claimDelivery(database.pool, refused, at(0));
    expect(await failDelivery(database.pool, refused, 1, { lastErrorCode: "550", now: at(1) })).toBe(true);
    expect(await getDeliveryForSend(database.pool, refused)).toMatchObject({ status: "failed" });

    const stale = await insertDelivery(database.pool, { alertId: alertId(23), recipient: RECIPIENT, now: at(0) });
    expect(await expireDelivery(database.pool, stale, at(1))).toBe(true);
    expect(await expireDelivery(database.pool, sent, at(1))).toBe(false);
    expect(await getDeliveryForSend(database.pool, stale)).toMatchObject({ status: "expired", attempt: 0 });

    const lost = await insertDelivery(database.pool, { alertId: alertId(24), recipient: RECIPIENT, now: at(0) });
    await claimDelivery(database.pool, lost, at(0));
    expect(await expireDelivery(database.pool, lost, at(59))).toBe(false);
    expect(await expireDelivery(database.pool, lost, at(61))).toBe(true);
    expect(await getDeliveryForSend(database.pool, lost)).toMatchObject({ status: "expired", attempt: 1, leaseUntil: null });
  });
});

describe("relay, SMTP pause and rate counting", () => {
  it("finds due and lost deliveries, fails a lost fifth attempt, keeps the longest pause, and lists counted send times", async () => {
    await database.pool.query("TRUNCATE app.alert_delivery");
    const due = await insertDelivery(database.pool, { alertId: alertId(30), recipient: RECIPIENT, now: at(0) });
    const later = await insertDelivery(database.pool, { alertId: alertId(31), recipient: RECIPIENT, now: at(0) });
    await holdDelivery(database.pool, later, { holdReason: "rate_limit", nextAttemptAt: at(3600), now: at(0) });
    const lost = await insertDelivery(database.pool, { alertId: alertId(32), recipient: RECIPIENT, now: at(0) });
    await claimDelivery(database.pool, lost, at(0));
    const lostLast = await insertDelivery(database.pool, { alertId: alertId(33), recipient: RECIPIENT, now: at(0) });
    await database.pool.query("UPDATE app.alert_delivery SET attempt = 4 WHERE id = $1", [lostLast]);
    await claimDelivery(database.pool, lostLast, at(0));
    const sent = await insertDelivery(database.pool, { alertId: alertId(34), recipient: RECIPIENT, now: at(0) });
    await claimDelivery(database.pool, sent, at(10));
    await markDeliverySent(database.pool, sent, 1, { smtpMessageId: null, now: at(12) });

    expect(await failLostDeliveries(database.pool, at(61))).toEqual([lostLast]);
    expect((await deliveriesDue(database.pool, at(61), 10)).sort()).toEqual([due, lost].sort());
    expect(await getDeliveryForSend(database.pool, lostLast)).toMatchObject({ status: "failed", attempt: 5 });
    expect(await database.pool.query("SELECT last_error_code FROM app.alert_delivery WHERE id = $1", [lostLast])).toMatchObject({
      rows: [{ last_error_code: "lease_lost" }],
    });
    expect((await sendTimesSince(database.pool, at(0))).map((d) => d.toISOString()).sort()).toEqual(
      [at(0), at(12)].map((d) => d.toISOString()).sort(),
    );

    expect(await smtpPausedUntil(database.pool, at(0))).toBeNull();
    await pauseSmtp(database.pool, at(900));
    await pauseSmtp(database.pool, at(300));
    expect(await smtpPausedUntil(database.pool, at(899))).toEqual(at(900));
    expect(await smtpPausedUntil(database.pool, at(900))).toBeNull();
  });
});

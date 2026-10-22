import { insertAlert, insertCandidate, insertDelivery, insertListing, upsertListingContent } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { fakeLegacyItemId } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createRelayHandler, type RelayDeps } from "./relay.js";

// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const MINUTE_MS = 60_000;
const itemKey = createItemKey(Buffer.alloc(32, 4).toString("base64"));

let db: TestDatabase;
let queue: JobQueue;

beforeAll(async () => {
  db = await createTestDatabase();
  queue = await startTestQueue(db);
}, 60_000);

afterAll(async () => {
  await queue.stop({ graceful: false, timeoutMs: 5_000 });
  await db.drop();
});

beforeEach(async () => {
  await resetTables(db);
});

// A delivery in the given state.
async function arrangeDelivery(fields: { status: string; attempt: number; nextAttemptAt: Date; leaseUntil: Date | null }): Promise<string> {
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
    createdAt: new Date(NOW.getTime() - 30 * MINUTE_MS),
  });
  const id = await insertDelivery(db.admin, { alertId: alert.id, recipient: "owner@example.test", now: new Date(NOW.getTime() - 30 * MINUTE_MS) });
  await db.admin.query(
    `UPDATE app.alert_delivery
        SET status = $2, attempt = $3, next_attempt_at = $4, lease_until = $5,
            sent_at = CASE WHEN $2 = 'sent' THEN $4::timestamptz END
      WHERE id = $1`,
    [id, fields.status, fields.attempt, fields.nextAttemptAt, fields.leaseUntil],
  );
  return id;
}

// A pending candidate, created `createdAgoMs` ago, with summary or getItem content.
async function arrangeCandidate(fields: { source: "summary" | "item"; createdAgoMs: number; enrichStartedAgoMs: number | null }): Promise<string> {
  const legacyItemId = fakeLegacyItemId();
  const key = itemKey(legacyItemId);
  const createdAt = new Date(NOW.getTime() - fields.createdAgoMs);
  const expires = new Date(NOW.getTime() + 3 * 60 * MINUTE_MS);
  const listingId = await insertListing(db.admin, {
    ...key,
    itemId: `v1|${legacyItemId}|0`,
    legacyItemId,
    feedId: "gpu",
    segment: "gpu_3090",
    firstSeenAt: createdAt,
    itemCreationAt: null,
    itemEndAt: null,
    contentExpiresAt: expires,
  });
  await upsertListingContent(db.admin, listingId, {
    source: fields.source,
    title: "RTX 3090 Founders Edition 24GB",
    condition: null,
    conditionDescription: null,
    sellerFeedbackScore: null,
    sellerFeedbackPct: null,
    sellerAccountType: null,
    returnsAccepted: null,
    returnsDays: null,
    itemLocationCountry: null,
    aspects: null,
    descriptionText: null,
    imageCount: null,
    fetchedAt: createdAt,
    contentExpiresAt: expires,
  });
  const candidateId = await insertCandidate(db.admin, {
    itemKey: key.itemKey,
    listingId,
    feedId: "gpu",
    segment: "gpu_3090",
    source: "poll",
    priceCents: 45000,
    shippingCents: 1000,
    landedCents: 46000,
    shippingKnown: true,
    totalGb: null,
    ruleVersion: 1,
    flags: [],
    createdAt,
  });
  if (fields.enrichStartedAgoMs !== null) {
    await db.admin.query("UPDATE app.candidate SET enrich_started_at = $2 WHERE id = $1", [
      candidateId,
      new Date(NOW.getTime() - fields.enrichStartedAgoMs),
    ]);
  }
  return listingId;
}

function setup(overrides: Partial<RelayDeps> = {}) {
  const clock = createTestClock(NOW);
  const log = createTestLog();
  const deps: RelayDeps = { pool: db.pool, queue, clock, log: log.log, ...overrides };
  const job = () => ({ id: "job-1", retryCount: 0, signal: new AbortController().signal });
  return { clock, log, deps, relay: createRelayHandler(deps), job };
}

describe("relay, the one retry path for send (section 2.4)", () => {
  it("queues send for pending deliveries that are due and sending ones past their lease, not for others", async () => {
    const due = await arrangeDelivery({ status: "pending", attempt: 1, nextAttemptAt: new Date(NOW.getTime() - MINUTE_MS), leaseUntil: null });
    const leaseLost = await arrangeDelivery({
      status: "sending",
      attempt: 2,
      nextAttemptAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
      leaseUntil: new Date(NOW.getTime() - 1000),
    });
    await arrangeDelivery({ status: "pending", attempt: 1, nextAttemptAt: new Date(NOW.getTime() + MINUTE_MS), leaseUntil: null });
    await arrangeDelivery({ status: "sending", attempt: 1, nextAttemptAt: NOW, leaseUntil: new Date(NOW.getTime() + 30_000) });
    await arrangeDelivery({ status: "sent", attempt: 1, nextAttemptAt: NOW, leaseUntil: null });
    const { relay, job } = setup();

    await relay({}, job());

    expect(await jobs(db, "send")).toEqual(expect.arrayContaining([{ deliveryId: due }, { deliveryId: leaseLost }]));
    expect(await jobs(db, "send")).toHaveLength(2);
  });

  it("fails a sending delivery past its lease on the fifth attempt with lease_lost, and queues nothing for it", async () => {
    const deliveryId = await arrangeDelivery({
      status: "sending",
      attempt: 5,
      nextAttemptAt: new Date(NOW.getTime() - 10 * MINUTE_MS),
      leaseUntil: new Date(NOW.getTime() - 1000),
    });
    const { relay, job, log } = setup();

    await relay({}, job());

    const result = await db.admin.query("SELECT status, last_error_code FROM app.alert_delivery");
    expect(result.rows).toEqual([{ status: "failed", last_error_code: "lease_lost" }]);
    expect(await jobs(db, "send")).toEqual([]);
    expect(log.events("delivery")).toEqual([
      { event: "delivery", delivery_id: deliveryId, status: "failed", hold_reason: null, attempt: 5, smtp_code: null, error: "lease_lost" },
    ]);
  });
});

describe("relay, lost enrich and screen jobs (section 2.4)", () => {
  it("queues screen for an enriched candidate without a finished screening 10 minutes after enrich started", async () => {
    const lost = await arrangeCandidate({ source: "item", createdAgoMs: 20 * MINUTE_MS, enrichStartedAgoMs: 11 * MINUTE_MS });
    await arrangeCandidate({ source: "item", createdAgoMs: 20 * MINUTE_MS, enrichStartedAgoMs: 5 * MINUTE_MS });
    // The enrich job died after getItem started and wrote no getItem content: enrich runs again
    // and finishes it from the summary. It never repeats a getItem that ran.
    const diedInEnrich = await arrangeCandidate({ source: "summary", createdAgoMs: 20 * MINUTE_MS, enrichStartedAgoMs: 11 * MINUTE_MS });
    await arrangeCandidate({ source: "summary", createdAgoMs: 20 * MINUTE_MS, enrichStartedAgoMs: 5 * MINUTE_MS });
    const { relay, job } = setup();

    await relay({}, job());

    expect(await jobs(db, "screen")).toEqual([{ listingId: lost }]);
    expect(await jobs(db, "enrich")).toEqual([{ listingId: diedInEnrich }]);
  });

  it("queues enrich for a pending candidate whose enrich never started 10 minutes after it was made", async () => {
    const lost = await arrangeCandidate({ source: "summary", createdAgoMs: 11 * MINUTE_MS, enrichStartedAgoMs: null });
    await arrangeCandidate({ source: "summary", createdAgoMs: 5 * MINUTE_MS, enrichStartedAgoMs: null });
    const { relay, job } = setup();

    await relay({}, job());

    expect(await jobs(db, "enrich")).toEqual([{ listingId: lost }]);
    expect(await jobs(db, "screen")).toEqual([]);
  });
});

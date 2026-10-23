import {
  claimScreening,
  insertCandidate,
  insertListing,
  saveProductWithPlan,
  upsertListingContent,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { PROMPT_VERSION } from "@ebay-sniper/llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { fakeLegacyItemId } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createHeldRequeueHandler } from "./held-requeue.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 4).toString("base64");
// 00:05 CEST on 22 Oct: the cron run at 22:05 UTC.
const NOW = new Date("2026-10-21T22:05:00.000Z");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
const itemKey = createItemKey(ITEM_KEY_SECRET);

let db: TestDatabase;
let queue: JobQueue;
let product: StoredProduct;

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
  await db.admin.query(
    "TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting CASCADE",
  );
  const result = await saveProductWithPlan(
    db.admin,
    {
      kind: "create",
      fields: {
        name: "Portrait lens",
        description: "A used 85 mm portrait lens for Sony E mount, the lens only.",
        status: "active",
        categoryId: "3323",
        conditionIds: ["3000"],
        searchWords: ["85mm"],
        mustWords: [["85mm"]],
        priceMode: "fixed",
        maxCents: 52_000,
        buyerProfile: "company",
        claudeRequired: true,
      },
    },
    { at: new Date(NOW.getTime() - 48 * HOUR_MS), actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  product = result.product;
});

type HeldFields = {
  heldReason?: string;
  // How long before NOW the listing was first seen.
  firstSeenAgoMs?: number;
  // "item": held in screen, after getItem; "summary": held in enrich, before getItem.
  content?: "item" | "summary";
  goneAt?: Date;
  itemEndAt?: Date;
};

type Held = { listingId: string; candidateId: string; itemKey: string };

// A candidate held by screen (getItem content, a skipped claim with the code) or by enrich (summary
// content only, no claim), as those jobs leave it.
async function arrangeHeld(fields: HeldFields = {}, now: Date = NOW): Promise<Held> {
  const legacyItemId = fakeLegacyItemId();
  const key = itemKey(legacyItemId);
  const heldReason = fields.heldReason ?? "cap_reached";
  const content = fields.content ?? "item";
  const seenAt = new Date(now.getTime() - (fields.firstSeenAgoMs ?? 2 * HOUR_MS));
  const enrichedAt = new Date(seenAt.getTime() + MINUTE_MS);
  const fetchedAt = content === "item" ? enrichedAt : seenAt;
  const expires = new Date(fetchedAt.getTime() + 6 * HOUR_MS);
  const listingId = await insertListing(db.admin, {
    ...key,
    itemId: `v1|${legacyItemId}|0`,
    legacyItemId,
    feedId: "gpu",
    segment: "gpu_3090",
    firstSeenAt: seenAt,
    itemCreationAt: new Date(seenAt.getTime() - HOUR_MS),
    itemEndAt: fields.itemEndAt ?? new Date(now.getTime() + 30 * 24 * HOUR_MS),
    contentExpiresAt: expires,
  });
  await db.admin.query("UPDATE ebay_live.listing SET feed_id = 's1', segment = $2, gone_at = $3, gone_reason = $4 WHERE id = $1", [
    listingId,
    product.key,
    fields.goneAt ?? null,
    fields.goneAt === undefined ? null : "ended",
  ]);
  await upsertListingContent(db.admin, listingId, {
    source: content,
    title: "Sigma 85mm F1.4 DG DN Art Sony E",
    condition: "Gebraucht",
    conditionDescription: null,
    sellerFeedbackScore: 250,
    sellerFeedbackPct: 100,
    sellerAccountType: "private",
    returnsAccepted: null,
    returnsDays: null,
    itemLocationCountry: "DE",
    aspects: null,
    descriptionText: null,
    imageCount: null,
    fetchedAt,
    contentExpiresAt: expires,
  });
  const candidateId = await insertCandidate(db.admin, {
    itemKey: key.itemKey,
    listingId,
    feedId: "s1",
    segment: product.key,
    source: "poll",
    priceCents: 45000,
    shippingCents: 1000,
    landedCents: 46000,
    shippingKnown: true,
    totalGb: null,
    ruleVersion: product.version,
    flags: [],
    createdAt: seenAt,
    productVersion: product.version,
    matchVersion: product.matchVersion,
    conditionGroup: "used",
    limitCents: 52_000,
    priceMode: "fixed",
    marketValueId: null,
  });
  await db.admin.query("UPDATE app.candidate SET decision = 'held', held_reason = $2 WHERE id = $1", [candidateId, heldReason]);
  if (content === "item") {
    await db.admin.query(
      `UPDATE app.candidate SET enrich_started_at = $2, prompt_version = $3, model = 'claude-sonnet-5-5', effort = 'medium'
        WHERE id = $1`,
      [candidateId, enrichedAt, PROMPT_VERSION],
    );
    await db.admin.query(
      `INSERT INTO app.screening (item_key, prompt_version, model, status, attempt, failure_code, created_at, updated_at)
       VALUES ($1, $2, 'claude-sonnet-5-5', 'skipped', 1, $3, $4, $4)`,
      [key.itemKey, PROMPT_VERSION, heldReason, enrichedAt],
    );
  }
  return { listingId, candidateId, itemKey: key.itemKey };
}

function setup(now: Date = NOW) {
  const clock = createTestClock(now);
  const log = createTestLog();
  const deps = { pool: db.pool, queue, clock, log: log.log };
  const job = () => ({ id: "job-1", retryCount: 0, signal: new AbortController().signal });
  return { log, requeue: createHeldRequeueHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

describe("held re-queue at 00:05 Berlin (spec 4.3, owner decision 6)", () => {
  it("puts a candidate held by a daily cap back on the screen queue, its skipped claim cleared", async () => {
    const held = await arrangeHeld();
    const { requeue, job } = setup();

    await requeue({}, job());

    expect(await rows("SELECT decision, held_reason, prompt_version, enrich_started_at IS NOT NULL AS enriched FROM app.candidate")).toEqual([
      { decision: "pending", held_reason: null, prompt_version: PROMPT_VERSION, enriched: true },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening WHERE item_key = $1", [held.itemKey])).toEqual([{ n: 0 }]);
    // The screen job's claim is a fresh attempt 1, so Claude is called this time.
    const claim = await claimScreening(db.pool, { itemKey: held.itemKey, promptVersion: PROMPT_VERSION, model: "claude-sonnet-5-5", now: NOW });
    expect(claim).toMatchObject({ kind: "claimed", attempt: 1 });
    expect(await jobs(db, "screen")).toEqual([{ listingId: held.listingId }]);
    expect(await jobs(db, "enrich")).toEqual([]);
  });

  it("sends a candidate held before getItem, or whose getItem content aged out, back to enrich", async () => {
    const beforeGetItem = await arrangeHeld({ content: "summary" });
    // Held at 13:30 the day before: the getItem content expired at 19:30.
    const aged = await arrangeHeld({ firstSeenAgoMs: 11 * HOUR_MS });
    await db.admin.query("DELETE FROM ebay_live.listing_content WHERE listing_id = $1", [aged.listingId]);
    const { requeue, job } = setup();

    await requeue({}, job());

    expect(await rows("SELECT decision, held_reason, enrich_started_at FROM app.candidate ORDER BY created_at")).toEqual([
      { decision: "pending", held_reason: null, enrich_started_at: null },
      { decision: "pending", held_reason: null, enrich_started_at: null },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "enrich")).toEqual(expect.arrayContaining([{ listingId: beforeGetItem.listingId }, { listingId: aged.listingId }]));
    expect(await jobs(db, "screen")).toEqual([]);
  });

  it("leaves other held reasons, gone or ended listings and listings first seen 12 hours ago or more held", async () => {
    const control = await arrangeHeld({ firstSeenAgoMs: 12 * HOUR_MS - MINUTE_MS, heldReason: "spend_cap_reached" });
    const kept = [
      await arrangeHeld({ heldReason: "details_unavailable" }),
      await arrangeHeld({ heldReason: "attempts_exhausted" }),
      await arrangeHeld({ goneAt: new Date(NOW.getTime() - HOUR_MS) }),
      await arrangeHeld({ itemEndAt: new Date(NOW.getTime() - MINUTE_MS) }),
      await arrangeHeld({ firstSeenAgoMs: 12 * HOUR_MS, content: "summary" }),
    ];
    const { requeue, job } = setup();

    await requeue({}, job());

    expect(await rows("SELECT id FROM app.candidate WHERE decision = 'pending'")).toEqual([{ id: control.candidateId }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.candidate WHERE decision = 'held'")).toEqual([{ n: kept.length }]);
    // Its getItem content expired 6 hours after the fetch, so enrich runs getItem again.
    expect(await jobs(db, "enrich")).toEqual([{ listingId: control.listingId }]);
    expect(await jobs(db, "screen")).toEqual([]);
  });

  it("logs what it put back per queue, and a second run finds nothing more to queue", async () => {
    await arrangeHeld();
    await arrangeHeld({ content: "summary" });
    const { requeue, job, log } = setup();

    await requeue({}, job());
    await requeue({}, job());

    expect(await jobs(db, "screen")).toHaveLength(1);
    expect(await jobs(db, "enrich")).toHaveLength(1);
    expect(log.events("held_requeue")).toEqual([
      { event: "held_requeue", screen: 1, enrich: 1 },
      { event: "held_requeue", screen: 0, enrich: 0 },
    ]);
  });

  it("acts only on the run at 00:05 Berlin: the cron fires at 22:05 and 23:05 UTC for summer and winter time", async () => {
    // 23:05 UTC is 01:05 CEST in summer time.
    await arrangeHeld();
    const summerLate = setup(new Date("2026-10-21T23:05:00.000Z"));
    await summerLate.requeue({}, summerLate.job());
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "held" }]);

    // Winter time from 25 Oct: 22:05 UTC is 23:05 CET, 23:05 UTC is 00:05 CET.
    await resetTables(db);
    const winterMidnight = new Date("2026-10-25T23:05:00.000Z");
    const winter = await arrangeHeld({}, winterMidnight);
    const winterEarly = setup(new Date("2026-10-25T22:05:00.000Z"));
    await winterEarly.requeue({}, winterEarly.job());
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "held" }]);
    const winterRun = setup(winterMidnight);
    await winterRun.requeue({}, winterRun.job());
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "pending" }]);
    expect(await jobs(db, "screen")).toEqual([{ listingId: winter.listingId }]);
  });
});

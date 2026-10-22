import { insertCandidate, insertListing, listingsToEnrich, upsertListingContent, type DbPool } from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import type { ListingFlag, Segment } from "@ebay-sniper/domain";
import { createClaudeScreener, WORST_CASE_COST_MICROUSD } from "@ebay-sniper/llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { CLAUDE_TEST_KEY, createFakeClaude } from "../testing/claude.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { createFakeEbay, createFakeReserve, fakeLegacyItemId, json, testGetItem } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createEnrichHandler, type EnrichDeps } from "./enrich.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 2).toString("base64");
// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const RECIPIENT = "owner@example.test";
const itemKey = createItemKey(ITEM_KEY_SECRET);

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

type Arranged = { listingId: string; candidateId: string; itemId: string; legacyItemId: string; itemKey: string };

type CandidateFields = {
  title?: string;
  segment?: Segment;
  priceCents?: number;
  shippingCents?: number | null;
  totalGb?: number | null;
  flags?: ListingFlag[];
  goneAt?: Date;
};

// A candidate as the poll transaction leaves it: listing, summary content, candidate row.
async function arrangeCandidate(admin: DbPool, fields: CandidateFields = {}): Promise<Arranged> {
  const legacyItemId = fakeLegacyItemId();
  const key = itemKey(legacyItemId);
  const itemId = `v1|${legacyItemId}|0`;
  const segment = fields.segment ?? "gpu_3090";
  const feedId = segment.startsWith("ram") ? "ram" : segment.startsWith("pc") ? "pc" : "gpu";
  const priceCents = fields.priceCents ?? 45000;
  const shippingCents = fields.shippingCents === undefined ? 1000 : fields.shippingCents;
  const seenAt = new Date(NOW.getTime() - 60_000);
  const expires = new Date(seenAt.getTime() + 6 * HOUR_MS);
  const listingId = await insertListing(admin, {
    ...key,
    itemId,
    legacyItemId,
    feedId,
    segment,
    firstSeenAt: seenAt,
    itemCreationAt: new Date(NOW.getTime() - HOUR_MS),
    itemEndAt: new Date(NOW.getTime() + 30 * 24 * HOUR_MS),
    contentExpiresAt: expires,
  });
  await upsertListingContent(admin, listingId, {
    source: "summary",
    title: fields.title ?? "RTX 3090 Founders Edition 24GB",
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
    fetchedAt: seenAt,
    contentExpiresAt: expires,
  });
  const candidateId = await insertCandidate(admin, {
    itemKey: key.itemKey,
    listingId,
    feedId,
    segment,
    source: "poll",
    priceCents,
    shippingCents,
    landedCents: shippingCents === null ? null : priceCents + shippingCents,
    shippingKnown: shippingCents !== null,
    totalGb: fields.totalGb ?? null,
    ruleVersion: 1,
    flags: fields.flags ?? [],
    createdAt: seenAt,
  });
  if (fields.goneAt !== undefined) {
    await admin.query("UPDATE ebay_live.listing SET gone_at = $2, gone_reason = 'ended' WHERE id = $1", [listingId, fields.goneAt]);
  }
  return { listingId, candidateId, itemId, legacyItemId, itemKey: key.itemKey };
}

// A getItem body. The seller username is in the raw body on purpose: the schema drops it.
function itemBody(arranged: Arranged, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: arranged.itemId,
    legacyItemId: arranged.legacyItemId,
    title: "RTX 3090 Founders Edition 24GB",
    price: { value: "450.00", currency: "EUR" },
    buyingOptions: ["FIXED_PRICE"],
    categoryId: "27386",
    condition: "Gebraucht",
    conditionId: "3000",
    conditionDescription: "Light signs of use.",
    description: "<p>Card works fine. Call me on 0171 2345678.</p><script>alert(1)</script>",
    localizedAspects: [
      { name: "Marke", value: "NVIDIA" },
      { name: "Speichergröße", value: "24 GB" },
    ],
    shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "12.50", currency: "EUR" } }],
    itemLocation: { country: "DE" },
    seller: { username: "fake-seller-name", feedbackScore: 250, feedbackPercentage: "99.5", sellerAccountType: "INDIVIDUAL" },
    returnTerms: { returnsAccepted: true, returnPeriod: { value: 30, unit: "DAY" } },
    image: { imageUrl: "https://i.ebayimg.test/1.jpg" },
    additionalImages: [{ imageUrl: "https://i.ebayimg.test/2.jpg" }, { imageUrl: "https://i.ebayimg.test/3.jpg" }],
    itemCreationDate: new Date(NOW.getTime() - HOUR_MS).toISOString(),
    itemEndDate: new Date(NOW.getTime() + 30 * 24 * HOUR_MS).toISOString(),
    ...fields,
  };
}

function setup(overrides: Partial<EnrichDeps> = {}) {
  const clock = createTestClock(NOW);
  const ebay = createFakeEbay();
  const reserve = createFakeReserve();
  const log = createTestLog();
  const claude = createFakeClaude();
  const deps: EnrichDeps = {
    pool: db.pool,
    queue,
    clock,
    getItem: testGetItem(ebay, clock)(reserve.reserve),
    postalCode: "80331",
    claude: {
      screener: createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn }),
      callLimit: 40,
      spendLimitMicrousd: 2_000_000,
    },
    alerts: { recipient: RECIPIENT, buyerProfile: "company" },
    log: log.log,
    ...overrides,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, ebay, reserve, log, claude, deps, enrich: createEnrichHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

describe("enrich with a Claude slot (section 2.4)", () => {
  it("fetches getItem on the alert path, stores the item content, updates shipping and queues screen", async () => {
    const arranged = await arrangeCandidate(db.admin, { shippingCents: null, flags: ["shipping_unknown"] });
    const { ebay, reserve, enrich, job, log, claude } = setup();
    ebay.item(arranged.itemId, itemBody(arranged));

    await enrich({ listingId: arranged.listingId }, job());

    expect(reserve.reservations).toEqual([{ resource: "buy.browse", callClass: "alert-path", purpose: "enrich", minLeft: 100 }]);
    const request = ebay.requests.find((r) => r.kind === "get_item");
    expect(request?.headers["x-ebay-c-enduserctx"]).toBe("contextualLocation=country%3DDE%2Czip%3D80331");
    expect(
      await rows(
        `SELECT source, title, condition_description, seller_feedback_score, seller_feedback_pct, seller_account_type,
                returns_accepted, returns_days, item_location_country, aspects, description_text, image_count,
                fetched_at, content_expires_at
           FROM ebay_live.listing_content`,
      ),
    ).toEqual([
      {
        source: "item",
        title: "RTX 3090 Founders Edition 24GB",
        condition_description: "Light signs of use.",
        seller_feedback_score: 250,
        seller_feedback_pct: 99.5,
        seller_account_type: "private",
        returns_accepted: true,
        returns_days: 30,
        item_location_country: "DE",
        aspects: [
          { name: "Marke", value: "NVIDIA" },
          { name: "Speichergröße", value: "24 GB" },
        ],
        description_text: "Card works fine. Call me on [PHONE].",
        image_count: 3,
        fetched_at: NOW,
        content_expires_at: new Date(NOW.getTime() + 6 * HOUR_MS),
      },
    ]);
    expect(await rows("SELECT content_expires_at FROM ebay_live.listing")).toEqual([
      { content_expires_at: new Date(NOW.getTime() + 6 * HOUR_MS) },
    ]);
    expect(
      await rows("SELECT shipping_cents, landed_cents, shipping_known, flags, decision, enrich_started_at FROM app.candidate"),
    ).toEqual([{ shipping_cents: 1250, landed_cents: 46250, shipping_known: true, flags: [], decision: "pending", enrich_started_at: NOW }]);
    expect(await jobs(db, "screen")).toEqual([{ listingId: arranged.listingId }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    // The slot check is read-only: the reservation happens in the screen job.
    expect(await rows("SELECT count(*)::int AS n FROM app.llm_usage_daily")).toEqual([{ n: 0 }]);
    expect(claude.requests).toHaveLength(0);
    expect(log.events("enrich_done")).toEqual([{ event: "enrich_done", listing_id: arranged.listingId, decision: "screen", slot: true }]);
    expect(log.text()).not.toContain("fake-seller-name");
  });

  it("keeps shipping unknown with the flag when getItem has no fixed cost to DE either", async () => {
    const arranged = await arrangeCandidate(db.admin, { shippingCents: null, flags: ["shipping_unknown"] });
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged, { shippingOptions: [{ shippingCostType: "CALCULATED" }] }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT shipping_cents, landed_cents, shipping_known, flags FROM app.candidate")).toEqual([
      { shipping_cents: null, landed_cents: null, shipping_known: false, flags: ["shipping_unknown"] },
    ]);
    expect(await jobs(db, "screen")).toHaveLength(1);
  });

  it("rejects after enrich on the getItem title and condition fields: no screen, no alert", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged, { conditionDescription: "Defekt, kein Bild." }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([
      { decision: "rejected_after_enrich", reject_reason: "defective" },
    ]);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("checks the model by the candidate's segment, not by a feed id this release does not know", async () => {
    const arranged = await arrangeCandidate(db.admin);
    // v2 polls per search and may write a search id where a feed id stood.
    await db.admin.query("UPDATE ebay_live.listing SET feed_id = 's3' WHERE id = $1", [arranged.listingId]);
    await db.admin.query("UPDATE app.candidate SET feed_id = 's3' WHERE id = $1", [arranged.candidateId]);
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([{ decision: "pending", reject_reason: null }]);
    expect(await jobs(db, "screen")).toEqual([{ listingId: arranged.listingId }]);
  });

  it("marks the listing gone on a getItem 404 and makes no alert", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests.filter((r) => r.kind === "get_item")).toHaveLength(1);
    expect(await rows("SELECT gone_at, gone_reason FROM ebay_live.listing")).toEqual([{ gone_at: NOW, gone_reason: "not_found" }]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "gone" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "screen")).toEqual([]);
  });

  it("marks an item that getItem shows as ended gone with reason ended", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged, { itemEndDate: new Date(NOW.getTime() - 60_000).toISOString() }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT gone_reason FROM ebay_live.listing")).toEqual([{ gone_reason: "ended" }]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "gone" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "screen")).toEqual([]);
  });

  it("alerts from the summary as details_unavailable when getItem fails on every attempt", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, reserve, enrich, job, log } = setup();
    ebay.item(arranged.itemId, () => json({ errors: [{ errorId: 10001 }] }, 503));

    await enrich({ listingId: arranged.listingId }, job());

    // A 5xx is retried once (A20), each attempt reserved.
    expect(reserve.reservations).toHaveLength(2);
    expect(await rows("SELECT final_verdict, screened, screening_id FROM app.alert")).toEqual([
      { final_verdict: "caution", screened: false, screening_id: null },
    ]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: details_unavailable");
    expect(message?.text_body).toContain("Returns:       not fetched");
    expect(await jobs(db, "send")).toHaveLength(1);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "alerted", slot: true, code: "details_unavailable" },
    ]);
  });
});

describe("enrich after getItem: price band, code scan, failures (sections 2.4, 3.3, 5.6)", () => {
  it("rejects above_max when the getItem shipping lifts the landed price over the max: no screen, no alert", async () => {
    // EUR 480 passed against the max of EUR 520 on the item price alone; getItem shipping is EUR 95.
    const arranged = await arrangeCandidate(db.admin, { priceCents: 48000, shippingCents: null, flags: ["shipping_unknown"] });
    const { ebay, enrich, job, log, claude } = setup();
    ebay.item(
      arranged.itemId,
      itemBody(arranged, {
        price: { value: "480.00", currency: "EUR" },
        shippingOptions: [{ shippingCostType: "FIXED", shippingCost: { value: "95.00", currency: "EUR" } }],
      }),
    );

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT price_cents, shipping_cents, landed_cents, decision, reject_reason FROM app.candidate")).toEqual([
      { price_cents: 48000, shipping_cents: 9500, landed_cents: 57500, decision: "rejected_after_enrich", reject_reason: "above_max" },
    ]);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(claude.requests).toHaveLength(0);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "rejected_after_enrich", slot: true, reason: "above_max" },
    ]);
  });

  it("checks the band on the getItem price: a price that fell below the floor is rejected below_floor", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged, { price: { value: "200.00", currency: "EUR" } }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT price_cents, landed_cents, decision, reject_reason FROM app.candidate")).toEqual([
      { price_cents: 20000, landed_cents: 21250, decision: "rejected_after_enrich", reject_reason: "below_floor" },
    ]);
    expect(await jobs(db, "screen")).toEqual([]);
  });

  it("stores the code signals of the raw description on the candidate, before the masking", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();
    ebay.item(
      arranged.itemId,
      itemBody(arranged, {
        description: "<p>Zahlung per Überweisung an DE89 3704 0044 0532 0130 00. Schreib mir per WhatsApp 0151 2345678.</p>",
      }),
    );

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT code_signals, decision FROM app.candidate")).toEqual([
      { code_signals: ["iban_present", "payment_mention", "off_ebay_contact_phrase"], decision: "pending" },
    ]);
    expect(await rows("SELECT description_text FROM ebay_live.listing_content")).toEqual([
      { description_text: "Zahlung per Überweisung an [IBAN]. Schreib mir per WhatsApp [PHONE]." },
    ]);
    expect(await jobs(db, "screen")).toHaveLength(1);
  });

  it("counts candidates waiting for their screen against the call cap: no getItem beyond it", async () => {
    const first = await arrangeCandidate(db.admin);
    const second = await arrangeCandidate(db.admin);
    const third = await arrangeCandidate(db.admin);
    const { ebay, deps, job } = setup();
    for (const arranged of [first, second, third]) ebay.item(arranged.itemId, itemBody(arranged));
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, callLimit: 2 } });

    for (const arranged of [first, second, third]) await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests.filter((r) => r.kind === "get_item")).toHaveLength(2);
    expect(await jobs(db, "screen")).toHaveLength(2);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: cap_reached");
    expect(await rows("SELECT decision FROM app.candidate WHERE id = $1", [third.candidateId])).toEqual([{ decision: "alerted" }]);
  });

  it("alerts from the summary as details_unavailable when storing the getItem content fails", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job, log } = setup();
    // Postgres text cannot hold a NUL character, so the content upsert fails.
    ebay.item(arranged.itemId, itemBody(arranged, { title: "RTX 3090 Founders\u0000 Edition" }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, screened FROM app.alert")).toEqual([{ final_verdict: "caution", screened: false }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: details_unavailable");
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "alerted" }]);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(log.events("enrich_failed")).toEqual([{ event: "enrich_failed", listing_id: arranged.listingId, error_code: "22021" }]);
  });

  it("finishes a candidate whose enrich job died after the getItem from the summary, without a second getItem", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query("UPDATE app.candidate SET enrich_started_at = $2 WHERE id = $1", [
      arranged.candidateId,
      new Date(NOW.getTime() - 11 * 60_000),
    ]);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: details_unavailable");
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "alerted" }]);
  });

  it("leaves a candidate whose enrich started under 10 minutes ago to the job that runs it", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query("UPDATE app.candidate SET enrich_started_at = $2 WHERE id = $1", [
      arranged.candidateId,
      new Date(NOW.getTime() - 60_000),
    ]);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "pending" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("marks the candidate expired when its content aged out before an alert could be made", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query("DELETE FROM ebay_live.listing_content WHERE listing_id = $1", [arranged.listingId]);
    const { ebay, deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "expired" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });
});

describe("enrich without a Claude slot (sections 2.4, 5.5, 6.1)", () => {
  it("makes no getItem and alerts from the summary as not_configured when there is no key", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, reserve, deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(reserve.reservations).toEqual([]);
    expect(ebay.requests).toEqual([]);
    const alerts = await rows<{ id: string }>(
      `SELECT id, candidate_id, screening_id, kind, tier, seq, segment, final_verdict, model_verdict, blocked_by_code,
              screened, flags, price_cents, shipping_cents, landed_cents, rule_version, buyer_profile, created_at
         FROM app.alert`,
    );
    expect(alerts).toEqual([
      {
        id: expect.any(String),
        candidate_id: arranged.candidateId,
        screening_id: null,
        kind: "band",
        tier: "none",
        seq: 1,
        segment: "gpu_3090",
        final_verdict: "caution",
        model_verdict: null,
        blocked_by_code: false,
        screened: false,
        flags: [],
        price_cents: 45000,
        shipping_cents: 1000,
        landed_cents: 46000,
        rule_version: 1,
        buyer_profile: "company",
        created_at: NOW,
      },
    ]);
  });

  it("gives the not-screened alert one pending delivery for ALERT_TO", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    const [alert] = await rows<{ id: string }>("SELECT id FROM app.alert");
    expect(await rows("SELECT alert_id, channel, recipient, status, attempt, next_attempt_at, hold_reason FROM app.alert_delivery")).toEqual([
      { alert_id: alert?.id, channel: "email", recipient: RECIPIENT, status: "pending", attempt: 0, next_attempt_at: NOW, hold_reason: null },
    ]);
  });

  it("stores the rendered not-screened email for the delivery, expiring with the summary content", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    const [delivery] = await rows<{ id: string }>("SELECT id FROM app.alert_delivery");
    const messages = await rows<{ delivery_id: string; subject: string; text_body: string; html_body: string; expires_at: Date }>(
      "SELECT delivery_id, subject, text_body, html_body, expires_at FROM ebay_live.alert_message",
    );
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.delivery_id).toBe(delivery?.id);
    expect(message?.subject).toBe("[Deal] RTX 3090: EUR 460 incl. shipping (88% of max) - NOT SCREENED");
    expect(message?.text_body).toContain("Not screened by Claude: not_configured");
    expect(message?.text_body).toContain("Returns:       not fetched");
    expect(message?.text_body).toContain(`https://www.ebay.de/itm/${arranged.legacyItemId}`);
    expect(message?.text_body).toContain(`Delivery ${delivery?.id}`);
    expect(message?.html_body).toContain("RTX 3090 Founders Edition 24GB");
    // 6 h after the summary was fetched.
    expect(message?.expires_at).toEqual(new Date(NOW.getTime() - 60_000 + 6 * HOUR_MS));
  });

  it("queues the send job for the delivery in the alert transaction", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    const [delivery] = await rows<{ id: string }>("SELECT id FROM app.alert_delivery");
    expect(await jobs(db, "send")).toEqual([{ deliveryId: delivery?.id }]);
  });

  it("marks the candidate alerted without starting enrich", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, enrich_started_at FROM app.candidate")).toEqual([{ decision: "alerted", enrich_started_at: null }]);
  });

  it("logs alert_created and enrich_done with the not-screened code", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    const [alert] = await rows<{ id: string }>("SELECT id FROM app.alert");
    expect(log.events("alert_created")).toEqual([
      { event: "alert_created", alert_id: alert?.id, final_verdict: "caution", blocked_by_code: false },
    ]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "alerted", slot: false, code: "not_configured" },
    ]);
  });

  it("makes no getItem and names cap_reached when the daily call cap is 0", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, callLimit: 0 } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: cap_reached");
  });

  it("makes no getItem and names spend_cap_reached when one more worst-case call would pass the spend cap", async () => {
    const arranged = await arrangeCandidate(db.admin);
    // Spent and reserved leave less than one worst-case call under USD 2.
    await db.admin.query(
      "INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 3, $1, $2)",
      [WORST_CASE_COST_MICROUSD, 2_000_000 - 2 * WORST_CASE_COST_MICROUSD + 1],
    );
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: spend_cap_reached");
  });

  it("makes no getItem and names paused while screening is paused after auth_failed", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query("INSERT INTO app.screening_pause (id, until) VALUES (1, $1)", [new Date(NOW.getTime() + 60_000)]);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not screened by Claude: paused");
  });

  it("makes no delivery when a code scam floor fires on the summary title, and marks the candidate blocked", async () => {
    const arranged = await arrangeCandidate(db.admin, { title: "RTX 3090 24GB nur PayPal Freunde" });
    const { deps, job } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, blocked_by_code FROM app.alert")).toEqual([{ final_verdict: "block", blocked_by_code: true }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert_delivery")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.alert_message")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "send")).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "blocked" }]);
  });

  it("logs enrich_done as blocked when the code scam floor kept the email back", async () => {
    const arranged = await arrangeCandidate(db.admin, { title: "RTX 3090 24GB nur PayPal Freunde" });
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());

    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "blocked", slot: false, code: "not_configured" },
    ]);
  });

  it("makes one alert, one delivery and one send job when two jobs both saw the candidate pending", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await enrich({ listingId: arranged.listingId }, job());
    // The second job read the candidate before the first one committed.
    await db.admin.query("UPDATE app.candidate SET decision = 'pending'");
    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 1 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert_delivery")).toEqual([{ n: 1 }]);
    expect(await jobs(db, "send")).toHaveLength(1);
    expect(log.events("alert_created")).toHaveLength(1);
  });
});

describe("enrich no-ops (section 2.4)", () => {
  it("never repeats a getItem that ran: a second job for the same candidate makes no call", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, reserve, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged));

    await enrich({ listingId: arranged.listingId }, job());
    await enrich({ listingId: arranged.listingId }, job());

    expect(reserve.reservations).toHaveLength(1);
    expect(await jobs(db, "screen")).toHaveLength(1);
  });

  it("makes no getItem for a gone or deleted listing and marks its candidate gone, so relay stops", async () => {
    const gone = await arrangeCandidate(db.admin, { goneAt: new Date(NOW.getTime() - 1000) });
    const deleted = await arrangeCandidate(db.admin);
    await db.admin.query("DELETE FROM ebay_live.listing WHERE id = $1", [deleted.listingId]);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: gone.listingId }, job());
    await enrich({ listingId: deleted.listingId }, job());
    await enrich({ listingId: "0199f0a2-7c1e-7b3a-9d4e-2f6a8b0c1d2e" }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision, enrich_started_at FROM app.candidate ORDER BY decision")).toEqual([
      { decision: "gone", enrich_started_at: null },
      { decision: "gone", enrich_started_at: null },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("expires a candidate whose segment key this release does not know, without a throw or a getItem, so relay stops", async () => {
    const arranged = await arrangeCandidate(db.admin);
    // A product key as v2 writes it.
    await db.admin.query("UPDATE app.candidate SET segment = 'p_k3x9ab2cde' WHERE id = $1", [arranged.candidateId]);
    const { ebay, enrich, job, log } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision, reject_reason, enrich_started_at FROM app.candidate")).toEqual([
      { decision: "expired", reject_reason: "unknown_segment", enrich_started_at: null },
    ]);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await listingsToEnrich(db.admin, new Date(NOW.getTime() + 11 * 60_000), 10)).toEqual([]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "expired", slot: false, reason: "unknown_segment" },
    ]);
  });
});

import {
  insertCandidate,
  insertListing,
  listingsToEnrich,
  saveProductWithPlan,
  upsertListingContent,
  type DbPool,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import { berlinDay } from "@ebay-sniper/domain";
import { createClaudeScreener, PROMPT_VERSION, worstCaseCostMicrousd } from "@ebay-sniper/llm";
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
// The code default of the claude.model setting.
const MODEL = "claude-sonnet-5-5";
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };
const TITLE = "Sigma 85mm F1.4 DG DN Art Sony E";

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

// A product as the form saves it. Every detail invented for the test.
async function createProduct(overrides: Record<string, unknown> = {}): Promise<StoredProduct> {
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
        excludeWords: ["adapter"],
        priceMode: "fixed",
        maxCents: 52_000,
        buyerProfile: "company",
        ...overrides,
      },
    },
    { at: new Date(NOW.getTime() - 48 * HOUR_MS), actor: "system:cli", userId: null, env: SETTINGS_ENV },
  );
  if (!result.ok) throw new Error(`save refused: ${JSON.stringify(result)}`);
  return result.product;
}

beforeEach(async () => {
  await resetTables(db);
  await db.admin.query(
    `TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product, app.setting,
       app.market_value, app.market_request, app.llm_usage_product_daily CASCADE`,
  );
  product = await createProduct();
});

type Arranged = { listingId: string; candidateId: string; itemId: string; legacyItemId: string; itemKey: string };

type CandidateFields = {
  title?: string;
  priceCents?: number;
  shippingCents?: number | null;
  totalGb?: number | null;
  flags?: string[];
  goneAt?: Date;
  key?: string;
};

// A candidate as the poll transaction leaves it: listing, summary content, candidate row with the
// product fields it passed (spec 2.8).
async function arrangeCandidate(admin: DbPool, fields: CandidateFields = {}): Promise<Arranged> {
  const legacyItemId = fakeLegacyItemId();
  const key = itemKey(legacyItemId);
  const itemId = `v1|${legacyItemId}|0`;
  const productKey = fields.key ?? product.key;
  const priceCents = fields.priceCents ?? 45000;
  const shippingCents = fields.shippingCents === undefined ? 1000 : fields.shippingCents;
  const seenAt = new Date(NOW.getTime() - 60_000);
  const expires = new Date(seenAt.getTime() + 6 * HOUR_MS);
  const listingId = await insertListing(admin, {
    ...key,
    itemId,
    legacyItemId,
    feedId: "gpu",
    segment: "gpu_3090",
    firstSeenAt: seenAt,
    itemCreationAt: new Date(NOW.getTime() - HOUR_MS),
    itemEndAt: new Date(NOW.getTime() + 30 * 24 * HOUR_MS),
    contentExpiresAt: expires,
  });
  // v2 writes the search id and the product key (spec 10.2 note a).
  await admin.query("UPDATE ebay_live.listing SET feed_id = 's1', segment = $2 WHERE id = $1", [listingId, productKey]);
  await upsertListingContent(admin, listingId, {
    source: "summary",
    title: fields.title ?? TITLE,
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
    feedId: "s1",
    segment: productKey,
    source: "poll",
    priceCents,
    shippingCents,
    landedCents: shippingCents === null ? null : priceCents + shippingCents,
    shippingKnown: shippingCents !== null,
    totalGb: fields.totalGb ?? null,
    ruleVersion: product.version,
    flags: fields.flags ?? [],
    createdAt: seenAt,
    productVersion: product.version,
    matchVersion: product.matchVersion,
    conditionGroup: "used",
    limitCents: 52_000,
    priceMode: "fixed",
    marketValueId: null,
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
    title: TITLE,
    price: { value: "450.00", currency: "EUR" },
    buyingOptions: ["FIXED_PRICE"],
    categoryId: "3323",
    condition: "Gebraucht",
    conditionId: "3000",
    conditionDescription: "Light signs of use.",
    description: "<p>Lens works fine. Call me on 0171 2345678.</p><script>alert(1)</script>",
    localizedAspects: [
      { name: "Marke", value: "Sigma" },
      { name: "Brennweite", value: "85 mm" },
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
    settingsEnv: SETTINGS_ENV,
    alerts: { recipient: RECIPIENT, buyerProfile: "company" },
    log: log.log,
    ...overrides,
  };
  const job = (signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount: 0, signal });
  return { clock, ebay, reserve, log, claude, deps, enrich: createEnrichHandler(deps), job };
}

const noScreener = (deps: EnrichDeps): EnrichDeps => ({ ...deps, claude: { ...deps.claude, screener: null } });

async function setSetting(key: string, value: unknown): Promise<void> {
  await db.admin.query("INSERT INTO app.setting (key, value, updated_at) VALUES ($1, $2, $3)", [key, JSON.stringify(value), NOW]);
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
        title: TITLE,
        condition_description: "Light signs of use.",
        seller_feedback_score: 250,
        seller_feedback_pct: 99.5,
        seller_account_type: "private",
        returns_accepted: true,
        returns_days: 30,
        item_location_country: "DE",
        aspects: [
          { name: "Marke", value: "Sigma" },
          { name: "Brennweite", value: "85 mm" },
        ],
        description_text: "Lens works fine. Call me on [PHONE].",
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

  it("writes the prompt version, model and effort of the settings now on the candidate at the hand-off (spec 4.5)", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await setSetting("claude.model", "claude-haiku-5-5");
    await setSetting("claude.effort", "low");
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT prompt_version, model, effort, held_reason FROM app.candidate")).toEqual([
      { prompt_version: PROMPT_VERSION, model: "claude-haiku-5-5", effort: "low", held_reason: null },
    ]);
    expect(await jobs(db, "screen")).toEqual([{ listingId: arranged.listingId }]);
  });

  it("checks the band on the product's limit now and stores the limit the candidate passed (spec 9)", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const lower = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();
    ebay.item(arranged.itemId, itemBody(arranged));
    ebay.item(lower.itemId, itemBody(lower));

    // A price edit after the poll: the candidate passed against EUR 520.
    await db.admin.query("UPDATE app.product SET max_cents = 60000 WHERE id = $1", [product.id]);
    await enrich({ listingId: arranged.listingId }, job());
    await db.admin.query("UPDATE app.product SET max_cents = 40000 WHERE id = $1", [product.id]);
    await enrich({ listingId: lower.listingId }, job());

    expect(
      await rows(
        "SELECT condition_group, limit_cents, price_mode, market_value_id, decision, reject_reason FROM app.candidate WHERE id = $1",
        [arranged.candidateId],
      ),
    ).toEqual([
      { condition_group: "used", limit_cents: 60000, price_mode: "fixed", market_value_id: null, decision: "pending", reject_reason: null },
    ]);
    expect(await rows("SELECT decision, reject_reason FROM app.candidate WHERE id = $1", [lower.candidateId])).toEqual([
      { decision: "rejected_after_enrich", reject_reason: "above_max" },
    ]);
    expect(await jobs(db, "screen")).toEqual([{ listingId: arranged.listingId }]);
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
    ebay.item(arranged.itemId, itemBody(arranged, { conditionDescription: "Defekt, Blende klemmt." }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([
      { decision: "rejected_after_enrich", reject_reason: "defective" },
    ]);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
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
    expect(message?.text_body).toContain("Not checked by Claude: details_unavailable");
    expect(message?.text_body).toContain("Returns:       not fetched");
    expect(await jobs(db, "send")).toHaveLength(1);
    expect(await jobs(db, "screen")).toEqual([]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "alerted", slot: true, outcome_code: "details_unavailable" },
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
    ebay.item(arranged.itemId, itemBody(arranged, { price: { value: "150.00", currency: "EUR" } }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT price_cents, landed_cents, decision, reject_reason FROM app.candidate")).toEqual([
      { price_cents: 15000, landed_cents: 16250, decision: "rejected_after_enrich", reject_reason: "below_floor" },
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
    await setSetting("claude.daily_call_limit", 2);
    const { ebay, enrich, job } = setup();
    for (const arranged of [first, second, third]) ebay.item(arranged.itemId, itemBody(arranged));

    for (const arranged of [first, second, third]) await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests.filter((r) => r.kind === "get_item")).toHaveLength(2);
    expect(await jobs(db, "screen")).toHaveLength(2);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: cap_reached");
    expect(await rows("SELECT decision FROM app.candidate WHERE id = $1", [third.candidateId])).toEqual([{ decision: "alerted" }]);
  });

  it("alerts from the summary as details_unavailable when storing the getItem content fails", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job, log } = setup();
    // Postgres text cannot hold a NUL character, so the content upsert fails.
    ebay.item(arranged.itemId, itemBody(arranged, { title: "Sigma 85mm F1.4\u0000 DG DN" }));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, screened FROM app.alert")).toEqual([{ final_verdict: "caution", screened: false }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: details_unavailable");
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
    expect(message?.text_body).toContain("Not checked by Claude: details_unavailable");
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
    const enrich = createEnrichHandler(noScreener(deps));

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
    const enrich = createEnrichHandler(noScreener(deps));

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
        segment: product.key,
        final_verdict: "caution",
        model_verdict: null,
        blocked_by_code: false,
        screened: false,
        flags: [],
        price_cents: 45000,
        shipping_cents: 1000,
        landed_cents: 46000,
        rule_version: product.version,
        buyer_profile: "company",
        created_at: NOW,
      },
    ]);
  });

  it("gives the not-screened alert one pending delivery for ALERT_TO", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [alert] = await rows<{ id: string }>("SELECT id FROM app.alert");
    expect(await rows("SELECT alert_id, channel, recipient, status, attempt, next_attempt_at, hold_reason FROM app.alert_delivery")).toEqual([
      { alert_id: alert?.id, channel: "email", recipient: RECIPIENT, status: "pending", attempt: 0, next_attempt_at: NOW, hold_reason: null },
    ]);
  });

  it("stores the rendered not-screened email for the delivery, expiring with the summary content", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [delivery] = await rows<{ id: string }>("SELECT id FROM app.alert_delivery");
    const messages = await rows<{ delivery_id: string; subject: string; text_body: string; html_body: string; expires_at: Date }>(
      "SELECT delivery_id, subject, text_body, html_body, expires_at FROM ebay_live.alert_message",
    );
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message?.delivery_id).toBe(delivery?.id);
    expect(message?.subject).toBe("[Deal] Portrait lens: EUR 460 incl. shipping (88 % of limit) - NOT CHECKED BY CLAUDE");
    expect(message?.text_body).toContain("Product:       Portrait lens\n");
    expect(message?.text_body).toContain("Limit:         EUR 520.00\n");
    expect(message?.text_body).toContain("Not checked by Claude: not_configured");
    expect(message?.text_body).toContain("Returns:       not fetched");
    expect(message?.text_body).toContain(`https://www.ebay.de/itm/${arranged.legacyItemId}`);
    expect(message?.text_body).toContain(`Delivery ${delivery?.id}`);
    expect(message?.html_body).toContain(TITLE);
    // 6 h after the summary was fetched.
    expect(message?.expires_at).toEqual(new Date(NOW.getTime() - 60_000 + 6 * HOUR_MS));
  });

  it("shows the market limit in the email and how far below the typical asking price the deal is (spec 6.4)", async () => {
    await db.admin.query("UPDATE app.product SET price_mode = 'below_market', below_market_pct = 15, max_cents = 60000 WHERE id = $1", [
      product.id,
    ]);
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
                                     n, neff, m_cents, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 20, 12, 56100, 56100)`,
      [product.id, product.matchVersion, new Date(NOW.getTime() - 3 * HOUR_MS)],
    );
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [message] = await rows<{ subject: string; text_body: string }>("SELECT subject, text_body FROM ebay_live.alert_message");
    expect(message?.subject).toBe(
      "[Deal] Portrait lens: EUR 460 incl. shipping (18 % below the typical asking price) - NOT CHECKED BY CLAUDE",
    );
    // 15 % below EUR 561, rounded down to EUR 10.
    expect(message?.text_body).toContain(
      ["Limit:         EUR 470.00", "               18 % below the typical asking price of EUR 561.00"].join("\n"),
    );
  });

  it("uses a value computed after the first sighting when none came before it, as the poll did, not the cap (spec 6.4)", async () => {
    await db.admin.query("UPDATE app.product SET price_mode = 'below_market', below_market_pct = 15, max_cents = 60000 WHERE id = $1", [
      product.id,
    ]);
    // The first sighting is 60 s before NOW; this value of the current match version came 30 s later.
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
                                     n, neff, m_cents, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 20, 12, 56100, 56100)`,
      [product.id, product.matchVersion, new Date(NOW.getTime() - 30_000)],
    );
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Limit:         EUR 470.00");
  });

  it("says using your cap in the email when a market-mode product has no reliable value (owner decision 7)", async () => {
    await db.admin.query("UPDATE app.product SET price_mode = 'below_market', below_market_pct = 15, max_cents = 60000 WHERE id = $1", [
      product.id,
    ]);
    // A value 7 days and 1 minute before the first sighting is too old to use.
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped,
                                     n, neff, m_cents, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 20, 12, 56100, 56100)`,
      [product.id, product.matchVersion, new Date(NOW.getTime() - 60_000 - 7 * 24 * HOUR_MS - 60_000)],
    );
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [message] = await rows<{ subject: string; text_body: string }>("SELECT subject, text_body FROM ebay_live.alert_message");
    expect(message?.subject).toBe("[Deal] Portrait lens: EUR 460 incl. shipping (using your cap) - NOT CHECKED BY CLAUDE");
    expect(message?.text_body).toContain(["Limit:         EUR 600.00, using your cap", "               77 % of your limit"].join("\n"));
  });

  it("queues the send job for the delivery in the alert transaction", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [delivery] = await rows<{ id: string }>("SELECT id FROM app.alert_delivery");
    expect(await jobs(db, "send")).toEqual([{ deliveryId: delivery?.id }]);
  });

  it("marks the candidate alerted without starting enrich", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, enrich_started_at FROM app.candidate")).toEqual([{ decision: "alerted", enrich_started_at: null }]);
  });

  it("logs alert_created and enrich_done with the not-screened code", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    const [alert] = await rows<{ id: string }>("SELECT id FROM app.alert");
    expect(log.events("alert_created")).toEqual([
      { event: "alert_created", alert_id: alert?.id, final_verdict: "caution", blocked_by_code: false },
    ]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "alerted", slot: false, outcome_code: "not_configured" },
    ]);
  });

  it("makes no getItem and names cap_reached when the daily call cap is 0", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await setSetting("claude.daily_call_limit", 0);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: cap_reached");
  });

  it("makes no getItem and names product_share_reached when the product used half of the day's calls (spec 4.4)", async () => {
    await createProduct({ name: "Tripod", searchWords: ["stativ"], mustWords: [["stativ"]], categoryId: "30090" });
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query(
      "INSERT INTO app.llm_usage_product_daily (day_berlin, product_key, calls) VALUES ($1::date, $2, 20)",
      [berlinDay(NOW), product.key],
    );
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: product_share_reached");
  });

  it("makes no getItem and names spend_cap_reached when one more worst-case call would pass the spend cap", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const worst = worstCaseCostMicrousd(MODEL);
    // Spent and reserved leave less than one worst-case call under USD 2.
    await db.admin.query(
      "INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 3, $1, $2)",
      [worst, 2_000_000 - 2 * worst + 1],
    );
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: spend_cap_reached");
  });

  it("makes no getItem and names paused while screening is paused after auth_failed", async () => {
    const arranged = await arrangeCandidate(db.admin);
    await db.admin.query("INSERT INTO app.screening_pause (id, until) VALUES (1, $1)", [new Date(NOW.getTime() + 60_000)]);
    const { ebay, enrich, job } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: paused");
  });

  it("holds the candidate instead of alerting when the product requires the Claude check (spec 4.3)", async () => {
    await db.admin.query("UPDATE app.product SET claude_required = true WHERE id = $1", [product.id]);
    const arranged = await arrangeCandidate(db.admin);
    await setSetting("claude.daily_call_limit", 0);
    const { ebay, enrich, job, log } = setup();

    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision, held_reason, reject_reason FROM app.candidate")).toEqual([
      { decision: "held", held_reason: "cap_reached", reject_reason: null },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert_delivery")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "send")).toEqual([]);
    expect(log.events("candidate_held")).toEqual([
      { event: "candidate_held", candidate_id: arranged.candidateId, held_reason: "cap_reached" },
    ]);
    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "held", slot: false, outcome_code: "cap_reached" },
    ]);
  });

  it("makes no delivery when a code scam floor fires on the summary title, and marks the candidate blocked", async () => {
    const arranged = await arrangeCandidate(db.admin, { title: "Sigma 85mm F1.4 nur PayPal Freunde" });
    const { deps, job } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, blocked_by_code FROM app.alert")).toEqual([{ final_verdict: "block", blocked_by_code: true }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert_delivery")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM ebay_live.alert_message")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "send")).toEqual([]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "blocked" }]);
  });

  it("logs enrich_done as blocked when the code scam floor kept the email back", async () => {
    const arranged = await arrangeCandidate(db.admin, { title: "Sigma 85mm F1.4 nur PayPal Freunde" });
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

    await enrich({ listingId: arranged.listingId }, job());

    expect(log.events("enrich_done")).toEqual([
      { event: "enrich_done", listing_id: arranged.listingId, decision: "blocked", slot: false, outcome_code: "not_configured" },
    ]);
  });

  it("makes one alert, one delivery and one send job when two jobs both saw the candidate pending", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { deps, job, log } = setup();
    const enrich = createEnrichHandler(noScreener(deps));

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

  it("ends the candidate expired when its product was paused or archived after the poll, without a getItem (spec 9)", async () => {
    const paused = await arrangeCandidate(db.admin);
    const archived = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();

    await db.admin.query("UPDATE app.product SET status = 'paused' WHERE id = $1", [product.id]);
    await enrich({ listingId: paused.listingId }, job());
    await db.admin.query("UPDATE app.product SET status = 'archived' WHERE id = $1", [product.id]);
    await enrich({ listingId: archived.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT id, decision, reject_reason FROM app.candidate ORDER BY reject_reason")).toEqual([
      { id: archived.candidateId, decision: "expired", reject_reason: "product_archived" },
      { id: paused.candidateId, decision: "expired", reject_reason: "product_paused" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("ends a candidate of a draft product expired, as when Release 0 candidates meet the imported drafts (spec 11.5)", async () => {
    const arranged = await arrangeCandidate(db.admin);
    const { ebay, enrich, job } = setup();

    await db.admin.query("UPDATE app.product SET status = 'draft' WHERE id = $1", [product.id]);
    await enrich({ listingId: arranged.listingId }, job());

    expect(ebay.requests).toEqual([]);
    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([{ decision: "expired", reject_reason: "product_paused" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("expires a candidate whose segment key this release does not know, without a throw or a getItem, so relay stops", async () => {
    // A key that names no product.
    const arranged = await arrangeCandidate(db.admin, { key: "p_k3x9ab2cde" });
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

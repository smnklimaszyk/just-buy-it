import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { DEALS_PAGE_SIZE, dealProducts, dealsPage, openDeals, overviewStatus, type Deal } from "./console-queries.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Spec 8.3 and 11.2 V6c: the reads of the overview and the deals page. Web makes them, so every
// call runs as role web; the rows are written the way the worker, the stores and the import do.

let database: TestDatabase;
let web: pg.Pool;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  web = new pg.Pool({ connectionString: database.url, max: 2, options: "-c role=web" });
});

afterAll(async () => {
  await web.end();
  await database.drop();
});

// 12:00 in Berlin.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const minutesAgo = (n: number): Date => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number): Date => minutesAgo(n * 60);

const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

beforeEach(async () => {
  await q(`TRUNCATE app.alert, app.candidate, app.screening, ebay_live.screening_text, ebay_live.listing_content,
    ebay_live.listing, app.market_value, app.product_revision, app.audit_event, app.search_product, app.search, app.product,
    app.poll_run, app.api_usage_hourly, app.ebay_quota_window, app.llm_usage_daily, app.worker_status, app.screening_pause,
    app.smtp_pause CASCADE`);
});

type ProductSeed = { key: string; name: string; maxCents?: number; perGb?: boolean; priceMode?: "fixed" | "below_market"; version?: number };

async function product(seed: ProductSeed): Promise<string> {
  const perGb = seed.perGb ?? false;
  const result = await q(
    `INSERT INTO app.product (key, name, description, category_id, condition_ids, search_words, must_words, price_mode,
       below_market_pct, max_cents, per_gb, unit_min_total, unit_max_total, sweep_minute, buyer_profile, version)
     VALUES ($1, $2, 'd', '3323', '{3000}', '{w}', '[["w"]]', $3, $4, $5, $6, $7, $8, 1, 'company', $9) RETURNING id`,
    [
      seed.key,
      seed.name,
      seed.priceMode ?? "fixed",
      seed.priceMode === "below_market" ? 20 : null,
      seed.maxCents ?? 50_000,
      perGb,
      perGb ? 16 : null,
      perGb ? 64 : null,
      seed.version ?? 1,
    ],
  );
  return (result.rows[0] as { id: string }).id;
}

async function revision(productId: string, version: number, rules: Record<string, unknown>, actor = "system:cli"): Promise<void> {
  await q("INSERT INTO app.product_revision (product_id, version, rules, actor, created_at) VALUES ($1, $2, $3, $4, $5)", [
    productId,
    version,
    rules,
    actor,
    hoursAgo(48),
  ]);
}

let items = 0;

type CandidateSeed = {
  key: string;
  decision: string;
  createdAt: Date;
  title?: string;
  legacyItemId?: string;
  contentExpiresAt?: Date;
  gone?: boolean;
  priceCents?: number | null;
  shippingCents?: number | null;
  totalGb?: number | null;
  ruleVersion?: number;
  productVersion?: number | null;
  limitCents?: number | null;
  priceMode?: "fixed" | "below_market" | null;
  marketValueId?: string | null;
  heldReason?: string | null;
};

// A candidate with its listing and, when a title is given, the listing's content.
async function candidate(seed: CandidateSeed): Promise<{ id: string; itemKey: string }> {
  items += 1;
  const itemKey = items.toString(16).padStart(64, "0");
  const expires = seed.contentExpiresAt ?? new Date(seed.createdAt.getTime() + 6 * 3_600_000);
  const gone = seed.gone === true;
  const listing = await q(
    `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at,
       last_confirmed_at, content_expires_at, gone_at, gone_reason)
     VALUES ($1, 1, 'v1|1|0', $2, 's1', $3, $4, $4, $5, $6, $7) RETURNING id`,
    [itemKey, seed.legacyItemId ?? String(100_000 + items), seed.key, seed.createdAt, expires, gone ? seed.createdAt : null, gone ? "ended" : null],
  );
  const listingId = (listing.rows[0] as { id: string }).id;
  if (seed.title !== undefined) {
    await q(
      "INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at) VALUES ($1, 'item', $2, $3, $4)",
      [listingId, seed.title, seed.createdAt, expires],
    );
  }
  const price = seed.priceCents === undefined ? 40_000 : seed.priceCents;
  const shipping = seed.shippingCents === undefined ? 0 : seed.shippingCents;
  const result = await q(
    `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_cents, landed_cents,
       shipping_known, total_gb, rule_version, decision, created_at, product_version, limit_cents, price_mode, market_value_id,
       held_reason)
     VALUES ($1, $2, 's1', $3, 'poll', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
    [
      itemKey,
      listingId,
      seed.key,
      price,
      shipping,
      price === null || shipping === null ? null : price + shipping,
      shipping !== null,
      seed.totalGb ?? null,
      seed.ruleVersion ?? 1,
      seed.decision,
      seed.createdAt,
      seed.productVersion === undefined ? 1 : seed.productVersion,
      seed.limitCents === undefined ? 50_000 : seed.limitCents,
      seed.priceMode === undefined ? "fixed" : seed.priceMode,
      seed.marketValueId ?? null,
      seed.heldReason ?? null,
    ],
  );
  return { id: (result.rows[0] as { id: string }).id, itemKey };
}

type AlertSeed = { finalVerdict?: "pass" | "caution" | "block"; screened?: boolean; blockedByCode?: boolean };

async function alert(target: { id: string; itemKey: string }, seed: AlertSeed = {}): Promise<void> {
  await q(
    `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, rule_version, buyer_profile, created_at)
     SELECT item_key, id, segment, $2, $3, $4, rule_version, 'company', created_at FROM app.candidate WHERE id = $1`,
    [target.id, seed.finalVerdict ?? "pass", seed.blockedByCode ?? false, seed.screened ?? true],
  );
}

async function screening(itemKey: string, productMatch: "match" | "mismatch" | "unclear", reason: string, expiresAt: Date): Promise<void> {
  const result = await q(
    `INSERT INTO app.screening (item_key, prompt_version, model, status, verdict, product_match, created_at, updated_at)
     VALUES ($1, 'p2-test', 'claude-sonnet-5-5', 'done', 'pass', $2, $3, $3) RETURNING id`,
    [itemKey, productMatch, hoursAgo(1)],
  );
  await q("INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, $2, $3)", [
    (result.rows[0] as { id: string }).id,
    reason,
    expiresAt,
  ]);
}

async function marketValue(productId: string, valueCents: number): Promise<string> {
  const result = await q(
    `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped, n,
       neff, m_cents, value_cents, counts)
     VALUES ($1, 'used', 1, $2, 'mv-1', 'ok', false, 20, 18, $3, $3, '{}') RETURNING id`,
    [productId, hoursAgo(20), valueCents],
  );
  return (result.rows[0] as { id: string }).id;
}

const byTitle = (deals: Deal[], title: string): Deal => {
  const found = deals.find((deal) => deal.title === title);
  if (found === undefined) throw new Error(`no deal titled ${title}`);
  return found;
};

describe("openDeals", () => {
  it("lists the alerted candidates of the last 24 h whose listing is still live, newest first, with the product's name", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    const newer = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: minutesAgo(30), title: "Newer lens", legacyItemId: "222" });
    await alert(newer);
    const older = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(5), title: "Older lens" });
    await alert(older);
    const stale = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(25), title: "Day-old lens" });
    await alert(stale);
    const gone = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1), title: "Sold lens", gone: true });
    await alert(gone);
    const blocked = await candidate({ key: "p_lens000001", decision: "blocked", createdAt: hoursAgo(1), title: "Blocked lens" });
    await alert(blocked, { finalVerdict: "block" });
    await candidate({ key: "p_lens000001", decision: "held", createdAt: hoursAgo(1), title: "Held lens" });
    await candidate({ key: "p_lens000001", decision: "pending", createdAt: hoursAgo(1), title: "Pending lens" });

    const deals = await openDeals(web, NOW);

    expect(deals.map((deal) => deal.title)).toEqual(["Newer lens", "Older lens"]);
    expect(deals[0]).toMatchObject({
      productKey: "p_lens000001",
      productName: "Portrait lens",
      decision: "alerted",
      legacyItemId: "222",
      priceCents: 40_000,
      shippingCents: 0,
      landedCents: 40_000,
      alertedAt: minutesAgo(30),
    });
  });

  it("gives no product name for a key no product has, so the page can show the key", async () => {
    await alert(await candidate({ key: "gpu_3090", decision: "alerted", createdAt: hoursAgo(2), title: "Old segment" }));

    const [deal] = await openDeals(web, NOW);

    expect(deal).toMatchObject({ productKey: "gpu_3090", productName: null });
  });

  it("drops the title and the link once the listing content has expired", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    await alert(await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(7), title: "Expired", contentExpiresAt: hoursAgo(1) }));

    const [deal] = await openDeals(web, NOW);

    expect(deal).toMatchObject({ title: null, legacyItemId: null });
  });

  it("takes the Claude result from the alert, and Claude's reason while its text is kept", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    const checked = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1), title: "Checked" });
    await alert(checked, { finalVerdict: "caution" });
    await screening(checked.itemKey, "match", "Seller is new.", hoursAgo(-5));
    await alert(await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(2), title: "Unchecked" }), { screened: false });
    const expired = await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(3), title: "Reason gone" });
    await alert(expired);
    await screening(expired.itemKey, "match", "Fine.", hoursAgo(1));

    const deals = await openDeals(web, NOW);

    expect(byTitle(deals, "Checked")).toMatchObject({
      verdict: { screened: true, finalVerdict: "caution", blockedByCode: false },
      productMatch: "match",
      claudeReason: "Seller is new.",
    });
    expect(byTitle(deals, "Unchecked")).toMatchObject({ verdict: { screened: false, finalVerdict: "pass", blockedByCode: false }, productMatch: null });
    expect(byTitle(deals, "Reason gone").claudeReason).toBeNull();
  });
});

describe("percent of limit", () => {
  it("comes from candidate.limit_cents, per GB of the total when the product prices per GB, and from the item price while shipping is unknown", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens", maxCents: 90_000 });
    await product({ key: "p_ram0000001", name: "Memory kit", perGb: true, maxCents: 300 });
    const lens = { key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1), limitCents: 50_000 };
    await alert(await candidate({ ...lens, title: "Fixed" }));
    await alert(await candidate({ ...lens, title: "No shipping", priceCents: 45_000, shippingCents: null }));
    await alert(
      await candidate({
        key: "p_ram0000001",
        decision: "alerted",
        createdAt: hoursAgo(1),
        title: "Per GB",
        priceCents: 12_000,
        shippingCents: 800,
        totalGb: 64,
        limitCents: 250,
      }),
    );

    const deals = await openDeals(web, NOW);

    expect(byTitle(deals, "Fixed")).toMatchObject({ limit: { cents: 50_000, perGb: false, from: "candidate" }, percentOfLimit: 80 });
    expect(byTitle(deals, "No shipping")).toMatchObject({ landedCents: null, percentOfLimit: 90 });
    expect(byTitle(deals, "Per GB")).toMatchObject({ limit: { cents: 250, perGb: true, from: "candidate" }, totalGb: 64, percentOfLimit: 80 });
  });

  it("falls back to the revision the candidate passed when limit_cents is empty, not to the product as it is now", async () => {
    const id = await product({ key: "p_lens000001", name: "Portrait lens", maxCents: 90_000, version: 3 });
    await revision(id, 2, { maxCents: 80_000, perGb: false });
    await revision(id, 3, { maxCents: 90_000, perGb: false });
    await alert(await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1), title: "Old row", limitCents: null, productVersion: 2 }));

    const [deal] = await openDeals(web, NOW);

    expect(deal).toMatchObject({ limit: { cents: 80_000, perGb: false, from: "revision" }, percentOfLimit: 50 });
  });

  it("measures a Release 0 row against the imported revision only when it passed the segment rule version the import copied", async () => {
    const id = await product({ key: "gpu_3090", name: "Graphics card" });
    await revision(id, 1, { maxCents: 64_000, perGb: false }, "system:import");
    await q("INSERT INTO app.audit_event (at, actor, action, detail) VALUES ($1, 'system:import', 'import.legacy_products', $2)", [
      hoursAgo(48),
      { products: [{ key: "gpu_3090", rule_version: 3 }] },
    ]);
    const release0 = { key: "gpu_3090", decision: "alerted", productVersion: null, limitCents: null, priceMode: null, priceCents: 48_000 };
    await alert(await candidate({ ...release0, createdAt: hoursAgo(1), title: "Same rule", ruleVersion: 3 }));
    await alert(await candidate({ ...release0, createdAt: hoursAgo(2), title: "Older rule", ruleVersion: 2 }));

    const deals = await openDeals(web, NOW);

    expect(byTitle(deals, "Same rule")).toMatchObject({ limit: { cents: 64_000, perGb: false, from: "revision" }, percentOfLimit: 75 });
    expect(byTitle(deals, "Older rule")).toMatchObject({ limit: null, percentOfLimit: null });
  });
});

describe("market line", () => {
  it("names the typical asking price the limit came from, or marks a market-mode candidate that used the cap", async () => {
    const id = await product({ key: "p_lens000001", name: "Portrait lens", priceMode: "below_market", maxCents: 60_000 });
    const valueId = await marketValue(id, 55_000);
    const lens = { key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1) };
    await alert(await candidate({ ...lens, title: "Market", priceCents: 41_250, limitCents: 44_000, priceMode: "below_market", marketValueId: valueId }));
    await alert(await candidate({ ...lens, title: "Cap", limitCents: 60_000, priceMode: "below_market" }));
    await alert(await candidate({ ...lens, title: "Fixed" }));
    await alert(await candidate({ ...lens, title: "Release 0", priceMode: null, limitCents: null, productVersion: null }));

    const deals = await openDeals(web, NOW);

    expect(byTitle(deals, "Market")).toMatchObject({
      priceMode: "below_market",
      usingCap: false,
      marketValue: { cents: 55_000, computedAt: hoursAgo(20), percentBelow: 25 },
    });
    expect(byTitle(deals, "Cap")).toMatchObject({ priceMode: "below_market", usingCap: true, marketValue: null });
    expect(byTitle(deals, "Fixed")).toMatchObject({ priceMode: "fixed", usingCap: false, marketValue: null });
    expect(byTitle(deals, "Release 0")).toMatchObject({ priceMode: null, usingCap: false, marketValue: null });
  });
});

describe("dealsPage", () => {
  it("lists alerts and held or wrong-product candidates of any age, newest first, and filters by product and by decision", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    await product({ key: "p_bike000001", name: "Road bike" });
    await alert(await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(1), title: "Alerted lens" }));
    await alert(await candidate({ key: "p_lens000001", decision: "blocked", createdAt: hoursAgo(2), title: "Blocked lens" }), { finalVerdict: "block" });
    await candidate({ key: "p_bike000001", decision: "held", createdAt: hoursAgo(3), title: "Held bike", heldReason: "claude_unavailable" });
    const wrong = await candidate({ key: "p_bike000001", decision: "wrong_product", createdAt: hoursAgo(4), title: "Frame only" });
    await screening(wrong.itemKey, "mismatch", "A frame set, not a bike.", hoursAgo(-1));
    // Three days old: its title is long deleted.
    await alert(await candidate({ key: "p_lens000001", decision: "alerted", createdAt: hoursAgo(72), title: "Old lens" }));
    await candidate({ key: "p_bike000001", decision: "pending", createdAt: hoursAgo(1), title: "Pending" });
    await candidate({ key: "p_bike000001", decision: "expired", createdAt: hoursAgo(1), title: "Expired" });

    const all = await dealsPage(web, { productKey: null, decision: null, page: 1 }, NOW);
    const bikes = await dealsPage(web, { productKey: "p_bike000001", decision: null, page: 1 }, NOW);
    const held = await dealsPage(web, { productKey: null, decision: "held", page: 1 }, NOW);

    expect(all.total).toBe(5);
    expect(all.rows.map((deal) => deal.title)).toEqual(["Alerted lens", "Blocked lens", "Held bike", "Frame only", null]);
    expect(bikes.rows.map((deal) => deal.title)).toEqual(["Held bike", "Frame only"]);
    expect(held).toMatchObject({ total: 1, rows: [{ title: "Held bike", heldReason: "claude_unavailable", verdict: null }] });
    expect(byTitle(all.rows, "Frame only")).toMatchObject({ productMatch: "mismatch", claudeReason: "A frame set, not a bike.", verdict: null });
  });

  it("pages by 50 rows and counts them all", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    for (let n = 0; n < 53; n += 1) {
      await candidate({ key: "p_lens000001", decision: "held", createdAt: minutesAgo(n + 1), title: `Held ${String(n)}` });
    }

    const first = await dealsPage(web, { productKey: null, decision: null, page: 1 }, NOW);
    const second = await dealsPage(web, { productKey: null, decision: null, page: 2 }, NOW);

    expect(DEALS_PAGE_SIZE).toBe(50);
    expect(first.total).toBe(53);
    expect(first.rows).toHaveLength(50);
    expect(second).toMatchObject({ total: 53, rows: [{ title: "Held 50" }, { title: "Held 51" }, { title: "Held 52" }] });
  });

  it("offers each product key that has deals as a filter, with its name when a product has it", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    await product({ key: "p_bike000001", name: "Road bike" });
    await candidate({ key: "p_lens000001", decision: "held", createdAt: hoursAgo(1) });
    await candidate({ key: "p_lens000001", decision: "wrong_product", createdAt: hoursAgo(1) });
    await candidate({ key: "gpu_3090", decision: "alerted", createdAt: hoursAgo(1) });
    await candidate({ key: "p_bike000001", decision: "pending", createdAt: hoursAgo(1) });

    expect(await dealProducts(web)).toEqual([
      { key: "gpu_3090", name: null },
      { key: "p_lens000001", name: "Portrait lens" },
    ]);
  });
});

describe("overviewStatus", () => {
  it("has zeros, no worker and no searches on an empty database", async () => {
    expect(await overviewStatus(web, NOW)).toEqual({
      dealsToday: 0,
      candidatesToday: 0,
      ebayCallsToday: 0,
      quotaUsed: 0,
      claude: { calls: 0, spentMicrousd: 0 },
      worker: null,
      searches: [],
      screeningPausedUntil: null,
      smtpPausedUntil: null,
    });
  });

  it("counts today's deals and candidates from Berlin midnight, and today's eBay calls and Claude usage", async () => {
    await product({ key: "p_lens000001", name: "Portrait lens" });
    const lens = { key: "p_lens000001" };
    await alert(await candidate({ ...lens, decision: "alerted", createdAt: minutesAgo(10) }));
    await alert(await candidate({ ...lens, decision: "blocked", createdAt: minutesAgo(20) }), { finalVerdict: "block" });
    await candidate({ ...lens, decision: "held", createdAt: minutesAgo(30) });
    // 23:30 in Berlin the evening before.
    await alert(await candidate({ ...lens, decision: "alerted", createdAt: new Date("2026-10-20T21:30:00.000Z") }));
    await q(
      `INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls) VALUES
         ('2026-10-20T22:00:00Z', 'buy.browse', 'poll', 7), ('2026-10-21T09:00:00Z', 'buy.browse', 'poll', 30),
         ('2026-10-21T09:00:00Z', 'buy.browse', 'get_item', 4), ('2026-10-20T21:00:00Z', 'buy.browse', 'poll', 99)`,
    );
    await q(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, used, used_standard, used_alert_path)
       VALUES ('buy.browse', $1, $2, 1234, 1200, 34), ('buy.browse', $3, $1, 4000, 4000, 0)`,
      [hoursAgo(3), hoursAgo(-21), hoursAgo(27)],
    );
    await q(
      `INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd)
       VALUES ('2026-10-21', 12, 0, 420000), ('2026-10-20', 40, 0, 2000000)`,
    );

    expect(await overviewStatus(web, NOW)).toMatchObject({
      dealsToday: 1,
      candidatesToday: 3,
      ebayCallsToday: 41,
      quotaUsed: 1234,
      claude: { calls: 12, spentMicrousd: 420_000 },
    });
  });

  it("gives the worker's heartbeat, each live search with its products and newest poll, and the pauses still running", async () => {
    const lens = await product({ key: "p_lens000001", name: "Portrait lens" });
    const bike = await product({ key: "p_bike000001", name: "Road bike" });
    const search = (id: string, enabled: boolean, retiredAt: Date | null) =>
      q(
        `INSERT INTO app.search (id, category_id, condition_ids, q, floor_eur, ceiling_eur, day_interval_s, night_interval_s, enabled,
           retired_at, members_hash)
         VALUES ($1, '3323', '{3000}', 'w', 0, 900, 300, 900, $2, $3, 'h')`,
        [id, enabled, retiredAt],
      );
    await search("s2", true, null);
    await search("s10", false, null);
    await search("s1", true, hoursAgo(5));
    await q("INSERT INTO app.search_product (search_id, product_id) VALUES ('s2', $1), ('s2', $2), ('s10', $2)", [lens, bike]);
    const run = (feedId: string, startedAt: Date, status: string) =>
      q("INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status) VALUES ($1, 'poll', $2, $3, $4)", [
        feedId,
        startedAt,
        status === "running" ? null : startedAt,
        status,
      ]);
    await run("s2", minutesAgo(20), "ok");
    await run("s2", minutesAgo(10), "running");
    await run("s1", minutesAgo(1), "ok");
    await q(
      `INSERT INTO app.worker_status (id, git_sha, started_at, heartbeat_at, smtp_configured, claude_configured)
       VALUES (1, 'abc', $1, $2, true, false)`,
      [hoursAgo(2), minutesAgo(1)],
    );
    await q("INSERT INTO app.screening_pause (id, until) VALUES (1, $1)", [minutesAgo(-15)]);
    await q("INSERT INTO app.smtp_pause (id, until) VALUES (1, $1)", [minutesAgo(5)]);

    const status = await overviewStatus(web, NOW);

    expect(status.worker).toEqual({ gitSha: "abc", startedAt: hoursAgo(2), heartbeatAt: minutesAgo(1), smtpConfigured: true, claudeConfigured: false });
    // By id number; a running row older than 5 minutes counts as an error (schedule.ts).
    expect(status.searches).toEqual([
      { id: "s2", enabled: true, products: ["Portrait lens", "Road bike"], lastPoll: { status: "error", startedAt: minutesAgo(10) } },
      { id: "s10", enabled: false, products: ["Road bike"], lastPoll: null },
    ]);
    expect(status.screeningPausedUntil).toEqual(minutesAgo(-15));
    expect(status.smtpPausedUntil).toBeNull();
  });
});

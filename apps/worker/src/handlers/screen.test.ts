import {
  insertCandidate,
  insertListing,
  listingsToScreen,
  saveProductWithPlan,
  upsertListingContent,
  type DbPool,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobQueue } from "@ebay-sniper/db/queue";
import type { CodeSignal } from "@ebay-sniper/domain";
import { createClaudeScreener, PROMPT_VERSION, worstCaseCostMicrousd } from "@ebay-sniper/llm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createItemKey } from "../item-key.js";
import { CLAUDE_TEST_KEY, claudeMessage, createFakeClaude, PASS_ANSWER } from "../testing/claude.js";
import { createTestClock } from "../testing/clock.js";
import { createTestDatabase, type TestDatabase } from "../testing/database.js";
import { fakeLegacyItemId } from "../testing/ebay.js";
import { createTestLog } from "../testing/log.js";
import { jobs, resetTables, startTestQueue } from "../testing/queue.js";
import { createScreenHandler, type ScreenDeps } from "./screen.js";

const ITEM_KEY_SECRET = Buffer.alloc(32, 3).toString("base64");
// 12:00 CEST.
const NOW = new Date("2026-10-21T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const RECIPIENT = "owner@example.test";
const itemKey = createItemKey(ITEM_KEY_SECRET);
const MODEL = "claude-sonnet-5-5";
const SONNET_WORST = worstCaseCostMicrousd(MODEL);
const SETTINGS_ENV = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

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

// The candidates below carry the key gpu_3090, as an imported product keeps its segment key
// (spec 2.13); the alert still names the segment rule of that key until enrich moves to products.
async function createProduct(overrides: Record<string, unknown> = {}, key = "gpu_3090"): Promise<StoredProduct> {
  const result = await saveProductWithPlan(
    db.admin,
    {
      kind: "create",
      key,
      fields: {
        name: "Graphics card",
        description: "A used graphics card with 24 GB of memory, the card only.",
        status: "active",
        categoryId: "27386",
        conditionIds: ["3000"],
        searchWords: ["3090"],
        mustWords: [["3090"]],
        excludeWords: ["defekt"],
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

type Arranged = { listingId: string; candidateId: string; legacyItemId: string; itemKey: string };

// A candidate as the enrich transaction leaves it: listing, getItem content, enrich started.
async function arrangeEnriched(
  admin: DbPool,
  fields: { title?: string; description?: string | null; codeSignals?: CodeSignal[] } = {},
): Promise<Arranged> {
  const legacyItemId = fakeLegacyItemId();
  const key = itemKey(legacyItemId);
  const fetchedAt = new Date(NOW.getTime() - 60_000);
  const expires = new Date(fetchedAt.getTime() + 6 * HOUR_MS);
  const listingId = await insertListing(admin, {
    ...key,
    itemId: `v1|${legacyItemId}|0`,
    legacyItemId,
    feedId: "gpu",
    segment: "gpu_3090",
    firstSeenAt: fetchedAt,
    itemCreationAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    itemEndAt: new Date(NOW.getTime() + 30 * 24 * HOUR_MS),
    contentExpiresAt: expires,
  });
  await upsertListingContent(admin, listingId, {
    source: "item",
    title: fields.title ?? "RTX 3090 Founders Edition 24GB",
    condition: "Gebraucht",
    conditionDescription: "Light signs of use.",
    sellerFeedbackScore: 250,
    sellerFeedbackPct: 100,
    sellerAccountType: "private",
    returnsAccepted: true,
    returnsDays: 30,
    itemLocationCountry: "DE",
    aspects: [{ name: "Marke", value: "NVIDIA" }],
    descriptionText: fields.description === undefined ? "Card works fine, two years of gaming use." : fields.description,
    imageCount: 3,
    fetchedAt,
    contentExpiresAt: expires,
  });
  const candidateId = await insertCandidate(admin, {
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
    createdAt: fetchedAt,
  });
  await admin.query("UPDATE app.candidate SET enrich_started_at = $2, code_signals = $3 WHERE id = $1", [
    candidateId,
    fetchedAt,
    fields.codeSignals ?? [],
  ]);
  return { listingId, candidateId, legacyItemId, itemKey: key.itemKey };
}

function setup(overrides: Partial<ScreenDeps> = {}) {
  const clock = createTestClock(NOW);
  const log = createTestLog();
  const claude = createFakeClaude();
  const deps: ScreenDeps = {
    pool: db.pool,
    queue,
    clock,
    claude: {
      screener: createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn }),
      callLimit: 40,
      spendLimitMicrousd: 2_000_000,
    },
    alerts: { recipient: RECIPIENT, buyerProfile: "company" },
    settingsEnv: SETTINGS_ENV,
    log: log.log,
    ...overrides,
  };
  const job = (retryCount = 0, signal: AbortSignal = new AbortController().signal) => ({ id: "job-1", retryCount, signal });
  return { clock, log, claude, deps, screen: createScreenHandler(deps), job };
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.admin.query(sql, params);
  return result.rows as T[];
}

describe("screen, a pass (sections 2.4, 5.3)", () => {
  it("calls Claude once and stores the done screening with its usage", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toHaveLength(1);
    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    expect(
      await rows(
        `SELECT item_key, prompt_version, model, status, attempt, verdict, product_match, risk_flags, code_signals, failure_code,
                request_bytes, input_tokens, output_tokens, cost_microusd, inference_geo, lease_until
           FROM app.screening`,
      ),
    ).toEqual([
      {
        item_key: arranged.itemKey,
        prompt_version: PROMPT_VERSION,
        model: MODEL,
        status: "done",
        attempt: 1,
        verdict: "pass",
        product_match: "match",
        risk_flags: [],
        code_signals: [],
        failure_code: null,
        request_bytes: Buffer.byteLength(userMessage, "utf8"),
        input_tokens: 2000,
        output_tokens: 800,
        cost_microusd: 2000 * 2 + 800 * 10,
        inference_geo: "global",
        lease_until: null,
      },
    ]);
  });

  it("sends the candidate's product, as the buyer wrote it, in the product element before the listing (spec 4.2)", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    const match = /^<product>\n(.*)\n<\/product>\n<listing>\n/s.exec(userMessage);
    expect(JSON.parse(match?.[1] ?? "null")).toEqual({
      name: "Graphics card",
      description: "A used graphics card with 24 GB of memory, the card only.",
      must_contain: [["3090"]],
      must_not_contain: ["defekt"],
      conditions: ["used"],
      limit_eur: 520,
    });
  });

  it("sends a market-mode product's current limit from the value of the listing's condition group, with that value", async () => {
    await db.admin.query("TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product CASCADE");
    const market = await createProduct({ priceMode: "below_market", belowMarketPct: 20, maxCents: 60_000 });
    const arranged = await arrangeEnriched(db.admin);
    await db.admin.query("UPDATE app.candidate SET condition_group = 'used' WHERE id = $1", [arranged.candidateId]);
    // The newest ok value of the group, computed before the listing was first seen.
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped, n, neff, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 20, 18, 50000)`,
      [market.id, market.matchVersion, new Date(NOW.getTime() - 3 * HOUR_MS)],
    );
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    // 20 % below EUR 500, under the cap of EUR 600.
    expect(userMessage).toContain('"limit_eur":400,"market_value_eur":500,"market_value_status":"ok"');
    expect(userMessage).toContain('"owner_max_eur": 400,');
  });

  it("sends the limit from a value computed after the first sighting when none came before it, as enrich did (spec 6.4)", async () => {
    await db.admin.query("TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product CASCADE");
    const market = await createProduct({ priceMode: "below_market", belowMarketPct: 20, maxCents: 60_000 });
    const arranged = await arrangeEnriched(db.admin);
    await db.admin.query("UPDATE app.candidate SET condition_group = 'used' WHERE id = $1", [arranged.candidateId]);
    // First seen 60 s before NOW; the value came 30 s after that.
    await db.admin.query(
      `INSERT INTO app.market_value (product_id, condition_group, match_version, computed_at, method_version, status, capped, n, neff, value_cents)
       VALUES ($1, 'used', $2, $3, 'mv-1', 'ok', false, 20, 18, 50000)`,
      [market.id, market.matchVersion, new Date(NOW.getTime() - 30_000)],
    );
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    expect(userMessage).toContain('"limit_eur":400,"market_value_eur":500,"market_value_status":"ok"');
  });

  it("reserves the worst case under both daily caps before the call and settles the actual cost after it", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT day_berlin::text AS day, calls, reserved_microusd::int AS reserved, spent_microusd::int AS spent FROM app.llm_usage_daily")).toEqual([
      { day: "2026-10-21", calls: 1, reserved: 0, spent: 12_000 },
    ]);
    expect(await rows("SELECT reserved_microusd FROM app.screening")).toEqual([{ reserved_microusd: SONNET_WORST }]);
  });

  it("makes the pass alert with its delivery, PASS email and send job in the result transaction", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const [screening] = await rows<{ id: string }>("SELECT id FROM app.screening");
    expect(await rows("SELECT screening_id, final_verdict, model_verdict, screened, blocked_by_code FROM app.alert")).toEqual([
      { screening_id: screening?.id, final_verdict: "pass", model_verdict: "pass", screened: true, blocked_by_code: false },
    ]);
    const [delivery] = await rows<{ id: string }>("SELECT id FROM app.alert_delivery");
    const [message] = await rows<{ subject: string; text_body: string }>("SELECT subject, text_body FROM ebay_live.alert_message");
    expect(message?.subject).toBe("[Deal] Graphics card: EUR 460 incl. shipping (88 % of limit) - PASS");
    expect(message?.text_body).toContain("Claude check: PASS");
    expect(message?.text_body).toContain("Returns:       accepted, 30 days");
    expect(await jobs(db, "send")).toEqual([{ deliveryId: delivery?.id }]);
    expect(await rows("SELECT decision FROM app.candidate")).toEqual([{ decision: "alerted" }]);
  });

  it("sends the code signals enrich stored to Claude, and a caution signal lifts a pass to CHECK", async () => {
    const arranged = await arrangeEnriched(db.admin, { codeSignals: ["payment_mention"] });
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    expect(userMessage).toContain('"code_signals": [\n    "payment_mention"\n  ]');
    expect(await rows("SELECT code_signals FROM app.screening")).toEqual([{ code_signals: ["payment_mention"] }]);
    expect(await rows("SELECT final_verdict, model_verdict FROM app.alert")).toEqual([{ final_verdict: "caution", model_verdict: "pass" }]);
    const [message] = await rows<{ subject: string }>("SELECT subject FROM ebay_live.alert_message");
    expect(message?.subject).toBe("[Deal] Graphics card: EUR 460 incl. shipping (88 % of limit) - CHECK");
  });

  it("lifts a model pass to CHECK when the model flagged prompt_injection", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();
    claude.answer({ verdict: "pass", product_match: "match", risk_flags: ["prompt_injection"], reason: "The text addresses a reviewer." });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, model_verdict FROM app.alert")).toEqual([{ final_verdict: "caution", model_verdict: "pass" }]);
    const [message] = await rows<{ subject: string }>("SELECT subject FROM ebay_live.alert_message");
    expect(message?.subject).toBe("[Deal] Graphics card: EUR 460 incl. shipping (88 % of limit) - CHECK");
    expect(await jobs(db, "send")).toHaveLength(1);
  });

  it("emails a model-only block marked CLAUDE SAYS BLOCK with the reason (Q7)", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();
    claude.answer({ verdict: "block", product_match: "match", risk_flags: ["wrong_model"], reason: "The listing shows an RTX 3080." });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT final_verdict, model_verdict, blocked_by_code FROM app.alert")).toEqual([
      { final_verdict: "block", model_verdict: "block", blocked_by_code: false },
    ]);
    const [message] = await rows<{ subject: string; text_body: string }>("SELECT subject, text_body FROM ebay_live.alert_message");
    expect(message?.subject).toBe("[Deal] Graphics card: EUR 460 incl. shipping (88 % of limit) - CLAUDE SAYS BLOCK");
    expect(message?.text_body).toContain("The listing shows an RTX 3080.");
    expect(await jobs(db, "send")).toHaveLength(1);
    expect(await rows("SELECT reason FROM ebay_live.screening_text")).toEqual([{ reason: "The listing shows an RTX 3080." }]);
  });

  it("ends the candidate wrong_product on a mismatch: no alert, no email, the reason kept (spec 4.3)", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job, log } = setup();
    claude.answer({ verdict: "block", product_match: "mismatch", risk_flags: [], reason: "The listing is a cooler, not a card." });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT decision, reject_reason, held_reason FROM app.candidate")).toEqual([
      { decision: "wrong_product", reject_reason: null, held_reason: null },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert_delivery")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "send")).toEqual([]);
    expect(await rows("SELECT status, product_match FROM app.screening")).toEqual([{ status: "done", product_match: "mismatch" }]);
    expect(await rows("SELECT reason FROM ebay_live.screening_text")).toEqual([{ reason: "The listing is a cooler, not a card." }]);
    expect(log.events("candidate_wrong_product")).toEqual([{ event: "candidate_wrong_product", candidate_id: arranged.candidateId }]);
  });

  it("sends the product's current limit, not the one of the segment rule (spec 9)", async () => {
    const arranged = await arrangeEnriched(db.admin);
    // An edit after enrich: the price of the product changed.
    await db.admin.query("UPDATE app.product SET max_cents = 60000 WHERE id = $1", [product.id]);
    await db.admin.query("UPDATE app.segment_rule SET max_landed_cents = 40000 WHERE segment = 'gpu_3090'");
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    const userMessage = String((claude.requests[0]?.body.messages as { content: string }[])[0]?.content);
    expect(userMessage).toContain('"limit_eur":600');
    expect(userMessage).toContain('"owner_max_eur": 600,');
    expect(userMessage).toContain('"percent_of_max": 77,');
  });

  it("logs screening_done with the latency from the clock, after the alert", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, clock, deps, job, log } = setup();
    const screen = createScreenHandler({
      ...deps,
      claude: {
        ...deps.claude,
        screener: {
          screen: async (call, signal) => {
            clock.advance(1_500);
            return createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn }).screen(call, signal);
          },
        },
      },
    });

    await screen({ listingId: arranged.listingId }, job());

    const [screening] = await rows<{ id: string; request_bytes: number }>("SELECT id, request_bytes FROM app.screening");
    expect(await rows("SELECT latency_ms FROM app.screening")).toEqual([{ latency_ms: 1500 }]);
    expect(log.events("screening_done")).toEqual([
      {
        event: "screening_done",
        screening_id: screening?.id,
        status: "done",
        verdict: "pass",
        failure_code: null,
        request_bytes: screening?.request_bytes,
        input_tokens: 2000,
        output_tokens: 800,
        cost_microusd: 12_000,
        latency_ms: 1500,
      },
    ]);
    expect(log.lines.map((l) => l.entry.event)).toEqual(["alert_created", "screening_done"]);
  });
});

describe("screen, model and caps from the settings (spec 4.4, 4.5, 9)", () => {
  async function setSetting(key: string, value: unknown): Promise<void> {
    await db.admin.query(
      `INSERT INTO app.setting (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = setting.version + 1`,
      [key, JSON.stringify(value), NOW],
    );
  }

  it("switches the model and effort on the next candidate after a settings change, without a restart", async () => {
    const first = await arrangeEnriched(db.admin);
    const second = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();

    await screen({ listingId: first.listingId }, job());
    await setSetting("claude.model", "claude-haiku-5-5");
    await setSetting("claude.effort", "low");
    await screen({ listingId: second.listingId }, job());

    expect(claude.requests.map((r) => [r.body.model, (r.body.output_config as { effort: string }).effort])).toEqual([
      ["claude-sonnet-5-5", "medium"],
      ["claude-haiku-5-5", "low"],
    ]);
    expect(await rows("SELECT item_key, model, status, reserved_microusd FROM app.screening ORDER BY created_at, model DESC")).toEqual([
      { item_key: first.itemKey, model: "claude-sonnet-5-5", status: "done", reserved_microusd: SONNET_WORST },
      { item_key: second.itemKey, model: "claude-haiku-5-5", status: "done", reserved_microusd: worstCaseCostMicrousd("claude-haiku-5-5") },
    ]);
  });

  it("reserves under the caps of the settings, read at call time, and clamps a stored cap above the .env ceiling", async () => {
    const statuses = async () => (await rows<{ failure_code: string | null }>("SELECT failure_code FROM app.screening ORDER BY created_at")).map((r) => r.failure_code);
    // A setting below the .env ceiling of 40 applies.
    await setSetting("claude.daily_call_limit", 1);
    const below = [await arrangeEnriched(db.admin), await arrangeEnriched(db.admin)];
    const { screen, job } = setup();
    for (const arranged of below) await screen({ listingId: arranged.listingId }, job());
    expect(await statuses()).toEqual([null, "cap_reached"]);

    // Written by SQL above a lowered ceiling of 1: the ceiling applies.
    await resetTables(db);
    await setSetting("claude.daily_call_limit", 100);
    const lowered = { ...SETTINGS_ENV, claudeDailyCallLimit: 1 };
    const above = [await arrangeEnriched(db.admin), await arrangeEnriched(db.admin)];
    const clamped = setup({ settingsEnv: lowered });
    for (const arranged of above) await clamped.screen({ listingId: arranged.listingId }, clamped.job());
    expect(await statuses()).toEqual([null, "cap_reached"]);
  });

  it("skips with product_share_reached when the product used half of the day's calls while another product is active", async () => {
    await createProduct({ name: "Second product", categoryId: "3323", searchWords: ["85mm"], mustWords: [["85mm"]] }, "gpu_4090");
    // 20 of the 40 calls of the Berlin day went to this product already.
    await db.admin.query("INSERT INTO app.llm_usage_product_daily (day_berlin, product_key, calls) VALUES ('2026-10-21', $1, 20)", [
      product.key,
    ]);
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "skipped", failure_code: "product_share_reached" }]);
    // The refused share took no call of the day.
    expect(await rows("SELECT count(*)::int AS n FROM app.llm_usage_daily WHERE calls > 0")).toEqual([{ n: 0 }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: product_share_reached");
  });

  it("uses the prompt version, model and effort fixed on the candidate, also when the setting changes between attempts", async () => {
    const arranged = await arrangeEnriched(db.admin);
    // As enrich writes them at the hand-off (spec 4.5).
    await db.admin.query("UPDATE app.candidate SET prompt_version = $2, model = 'claude-opus-5-5', effort = 'high' WHERE id = $1", [
      arranged.candidateId,
      PROMPT_VERSION,
    ]);
    await setSetting("claude.model", "claude-haiku-5-5");
    const { claude, screen, job } = setup();
    claude.status(529);

    await expect(screen({ listingId: arranged.listingId }, job(0))).rejects.toMatchObject({ code: "provider_unavailable" });
    await setSetting("claude.model", "claude-sonnet-5-5");
    await screen({ listingId: arranged.listingId }, job(1));

    expect(claude.requests.map((r) => [r.body.model, (r.body.output_config as { effort: string }).effort])).toEqual([
      ["claude-opus-5-5", "high"],
      ["claude-opus-5-5", "high"],
    ]);
    expect(await rows("SELECT prompt_version, model, status, attempt FROM app.screening")).toEqual([
      { prompt_version: PROMPT_VERSION, model: "claude-opus-5-5", status: "done", attempt: 2 },
    ]);
    expect(await rows("SELECT calls FROM app.llm_usage_daily")).toEqual([{ calls: 2 }]);
  });
});

describe("screen without a call (section 5.5 skip codes)", () => {
  it("skips with cap_reached when the reservation is refused, and alerts as not screened", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, deps, job } = setup();
    // CLAUDE_DAILY_CALL_LIMIT=0 bounds the setting to 0.
    const screen = createScreenHandler({ ...deps, settingsEnv: { ...SETTINGS_ENV, claudeDailyCallLimit: 0 } });

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT status, failure_code, lease_until FROM app.screening")).toEqual([
      { status: "skipped", failure_code: "cap_reached", lease_until: null },
    ]);
    const [screening] = await rows<{ id: string }>("SELECT id FROM app.screening");
    expect(await rows("SELECT screening_id, final_verdict, model_verdict, screened FROM app.alert")).toEqual([
      { screening_id: screening?.id, final_verdict: "caution", model_verdict: null, screened: false },
    ]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: cap_reached");
    expect(await jobs(db, "send")).toHaveLength(1);
  });

  it("holds the candidate with the skip code when the product requires the Claude check: no alert (spec 4.3)", async () => {
    await db.admin.query("UPDATE app.product SET claude_required = true WHERE id = $1", [product.id]);
    const arranged = await arrangeEnriched(db.admin);
    const { claude, deps, job } = setup();
    const screen = createScreenHandler({ ...deps, settingsEnv: { ...SETTINGS_ENV, claudeDailyCallLimit: 0 } });

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT decision, held_reason FROM app.candidate")).toEqual([{ decision: "held", held_reason: "cap_reached" }]);
    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "skipped", failure_code: "cap_reached" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await jobs(db, "send")).toEqual([]);
  });

  it("skips with paused while screening is paused, without reserving", async () => {
    const arranged = await arrangeEnriched(db.admin);
    await db.admin.query("INSERT INTO app.screening_pause (id, until) VALUES (1, $1)", [new Date(NOW.getTime() + 60_000)]);
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "skipped", failure_code: "paused" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.llm_usage_daily")).toEqual([{ n: 0 }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: paused");
  });

  it("skips with not_configured when the key was removed after enrich", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { deps, job } = setup();
    const screen = createScreenHandler({ ...deps, claude: { ...deps.claude, screener: null } });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "skipped", failure_code: "not_configured" }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: not_configured");
  });
});

describe("screen failures (section 5.5)", () => {
  it("fails at once on a non-retryable code, stores the billed usage and alerts as not screened", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();
    claude.message(claudeMessage(PASS_ANSWER, { stopReason: "refusal", usage: { input_tokens: 1500, output_tokens: 100 } }));

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toHaveLength(1);
    expect(await rows("SELECT status, attempt, failure_code, input_tokens, output_tokens, cost_microusd, lease_until FROM app.screening")).toEqual([
      { status: "failed", attempt: 1, failure_code: "refused", input_tokens: 1500, output_tokens: 100, cost_microusd: 4000, lease_until: null },
    ]);
    expect(await rows("SELECT calls, reserved_microusd::int AS reserved, spent_microusd::int AS spent FROM app.llm_usage_daily")).toEqual([
      { calls: 1, reserved: 0, spent: 4000 },
    ]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: refused");
    expect(await rows("SELECT final_verdict, screened FROM app.alert")).toEqual([{ final_verdict: "caution", screened: false }]);
  });

  it("logs screening_done for a failed screening with its code and usage", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job, log } = setup();
    claude.message(claudeMessage(PASS_ANSWER, { stopReason: "refusal", usage: { input_tokens: 1500, output_tokens: 100 } }));

    await screen({ listingId: arranged.listingId }, job());

    const [screening] = await rows<{ id: string; request_bytes: number }>("SELECT id, request_bytes FROM app.screening");
    expect(log.events("screening_done")).toEqual([
      {
        event: "screening_done",
        screening_id: screening?.id,
        status: "failed",
        verdict: null,
        failure_code: "refused",
        request_bytes: screening?.request_bytes,
        input_tokens: 1500,
        output_tokens: 100,
        cost_microusd: 4000,
        latency_ms: 0,
      },
    ]);
  });

  it("releases the lease at once on a retryable failure of attempt 1 and throws, so the retry runs as attempt 2", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();
    claude.hang();

    // The job's deadline fires while Claude hangs: a timeout.
    await expect(screen({ listingId: arranged.listingId }, job(0, AbortSignal.abort()))).rejects.toMatchObject({ code: "timeout" });

    expect(await rows("SELECT status, attempt, failure_code, lease_until, cost_microusd FROM app.screening")).toEqual([
      { status: "running", attempt: 1, failure_code: "timeout", lease_until: NOW, cost_microusd: null },
    ]);
    // No usage came back, so the worst case is spent.
    expect(await rows("SELECT calls, reserved_microusd::int AS reserved, spent_microusd::int AS spent FROM app.llm_usage_daily")).toEqual([
      { calls: 1, reserved: 0, spent: SONNET_WORST },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);

    // The pg-boss retry, 30 s later, takes the released lease over at once.
    await screen({ listingId: arranged.listingId }, job(1));

    expect(claude.requests).toHaveLength(2);
    expect(await rows("SELECT status, attempt, verdict FROM app.screening")).toEqual([{ status: "done", attempt: 2, verdict: "pass" }]);
    expect(await rows("SELECT final_verdict, screened FROM app.alert")).toEqual([{ final_verdict: "pass", screened: true }]);
  });

  it("drops a late result when another attempt took the claim over meanwhile: no alert from it", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, deps, job } = setup();
    const real = createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn });
    const screen = createScreenHandler({
      ...deps,
      claude: {
        ...deps.claude,
        screener: {
          screen: async (call, signal) => {
            // While this call runs, its lease ran out and a retry took over as attempt 2.
            await db.admin.query("UPDATE app.screening SET attempt = 2");
            return real.screen(call, signal);
          },
        },
      },
    });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT status, attempt, verdict FROM app.screening")).toEqual([{ status: "running", attempt: 2, verdict: null }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    // The call was paid for all the same.
    expect(await rows("SELECT spent_microusd::int AS spent FROM app.llm_usage_daily")).toEqual([{ spent: 12_000 }]);
  });

  it("drops a late failure when another attempt took the claim over meanwhile", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, deps, job } = setup();
    const real = createClaudeScreener({ apiKey: CLAUDE_TEST_KEY, fetchFn: claude.fetchFn });
    claude.status(400);
    const screen = createScreenHandler({
      ...deps,
      claude: {
        ...deps.claude,
        screener: {
          screen: async (call, signal) => {
            await db.admin.query("UPDATE app.screening SET attempt = 2");
            return real.screen(call, signal);
          },
        },
      },
    });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT status, attempt FROM app.screening")).toEqual([{ status: "running", attempt: 2 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("fails on attempt 2 after a retryable failure and alerts as not screened: at most 2 paid calls", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job } = setup();
    claude.status(529);
    claude.status(529);

    await expect(screen({ listingId: arranged.listingId }, job(0))).rejects.toMatchObject({ code: "provider_unavailable" });
    await screen({ listingId: arranged.listingId }, job(1));

    expect(claude.requests).toHaveLength(2);
    expect(await rows("SELECT status, attempt, failure_code FROM app.screening")).toEqual([
      { status: "failed", attempt: 2, failure_code: "provider_unavailable" },
    ]);
    expect(await rows("SELECT calls FROM app.llm_usage_daily")).toEqual([{ calls: 2 }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: provider_unavailable");
  });

  it("pauses screening for 15 minutes on auth_failed and logs it, without the key in the log", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const { claude, screen, job, log } = setup();
    claude.status(401, { error: { message: `invalid x-api-key ${CLAUDE_TEST_KEY}` } });

    await screen({ listingId: arranged.listingId }, job());

    expect(await rows("SELECT until FROM app.screening_pause")).toEqual([{ until: new Date(NOW.getTime() + 15 * 60_000) }]);
    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "failed", failure_code: "auth_failed" }]);
    expect(log.events("screening_paused")).toEqual([
      { event: "screening_paused", until: new Date(NOW.getTime() + 15 * 60_000).toISOString(), failure_code: "auth_failed" },
    ]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: auth_failed");
    expect(log.text()).not.toContain(CLAUDE_TEST_KEY);
  });

  it("waits out a retry-after above the 30 s retry delay before releasing the lease on a 429", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const waits: number[] = [];
    const { claude, deps, job } = setup();
    const screen = createScreenHandler({
      ...deps,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    claude.status(429, { type: "error" }, { "retry-after": "45" });

    await expect(screen({ listingId: arranged.listingId }, job())).rejects.toMatchObject({ code: "rate_limited" });

    // 15 s here plus the 30 s pg-boss retry delay: the retry runs after 45 s.
    expect(waits).toEqual([15_000]);
    expect(await rows("SELECT status, attempt, failure_code, lease_until FROM app.screening")).toEqual([
      { status: "running", attempt: 1, failure_code: "rate_limited", lease_until: NOW },
    ]);
  });
});

// A screening row as another job left it.
async function arrangeScreening(
  arranged: Arranged,
  fields: { status: string; attempt: number; leaseUntil: Date | null; verdict?: string; failureCode?: string },
): Promise<string> {
  const result = await db.admin.query<{ id: string }>(
    `INSERT INTO app.screening (item_key, prompt_version, model, status, attempt, lease_until, verdict, product_match, failure_code,
                                created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [
      arranged.itemKey,
      PROMPT_VERSION,
      MODEL,
      fields.status,
      fields.attempt,
      fields.leaseUntil,
      fields.verdict ?? null,
      fields.verdict === undefined ? null : "match",
      fields.failureCode ?? null,
      new Date(NOW.getTime() - 5 * 60_000),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("no screening row");
  return id;
}

describe("screen claim (section 2.4)", () => {
  it("exits without a call while another job holds a live lease", async () => {
    const arranged = await arrangeEnriched(db.admin);
    await arrangeScreening(arranged, { status: "running", attempt: 1, leaseUntil: new Date(NOW.getTime() + 30_000) });
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.llm_usage_daily")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
  });

  it("alerts as not screened with attempts_exhausted when attempt 2 lost its lease (a crash)", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const screeningId = await arrangeScreening(arranged, { status: "running", attempt: 2, leaseUntil: new Date(NOW.getTime() - 1000) });
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT status, failure_code FROM app.screening")).toEqual([{ status: "failed", failure_code: "attempts_exhausted" }]);
    expect(await rows("SELECT screening_id, screened FROM app.alert")).toEqual([{ screening_id: screeningId, screened: false }]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Not checked by Claude: attempts_exhausted");
  });

  it("reuses a finished screening without a call and makes the alert from it", async () => {
    const arranged = await arrangeEnriched(db.admin);
    const screeningId = await arrangeScreening(arranged, { status: "done", attempt: 1, leaseUntil: null, verdict: "caution" });
    await db.admin.query("INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, $2, $3)", [
      screeningId,
      "Ask the seller about the fan noise.",
      new Date(NOW.getTime() + HOUR_MS),
    ]);
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT screening_id, final_verdict, model_verdict, screened FROM app.alert")).toEqual([
      { screening_id: screeningId, final_verdict: "caution", model_verdict: "caution", screened: true },
    ]);
    const [message] = await rows<{ text_body: string }>("SELECT text_body FROM ebay_live.alert_message");
    expect(message?.text_body).toContain("Ask the seller about the fan noise.");
  });
});

describe("screen no-ops", () => {
  it("makes no claim and no call for a candidate that already has its decision", async () => {
    const arranged = await arrangeEnriched(db.admin);
    await db.admin.query("UPDATE app.candidate SET decision = 'alerted'");
    const { claude, screen, job } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
  });

  it("makes no call for a gone listing or one whose content is still the summary", async () => {
    const gone = await arrangeEnriched(db.admin);
    await db.admin.query("UPDATE ebay_live.listing SET gone_at = $2, gone_reason = 'ended' WHERE id = $1", [gone.listingId, NOW]);
    const summaryOnly = await arrangeEnriched(db.admin);
    await db.admin.query("UPDATE ebay_live.listing_content SET source = 'summary' WHERE listing_id = $1", [summaryOnly.listingId]);
    const { claude, screen, job } = setup();

    await screen({ listingId: gone.listingId }, job());
    await screen({ listingId: summaryOnly.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
  });

  it("ends the candidate expired when its product was paused or archived after enrich, without a claim or a call (spec 9)", async () => {
    const paused = await arrangeEnriched(db.admin);
    const archived = await arrangeEnriched(db.admin);
    const { claude, screen, job, log } = setup();

    await db.admin.query("UPDATE app.product SET status = 'paused' WHERE id = $1", [product.id]);
    await screen({ listingId: paused.listingId }, job());
    await db.admin.query("UPDATE app.product SET status = 'archived' WHERE id = $1", [product.id]);
    await screen({ listingId: archived.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT id, decision, reject_reason FROM app.candidate ORDER BY created_at, id")).toEqual(
      expect.arrayContaining([
        { id: paused.candidateId, decision: "expired", reject_reason: "product_paused" },
        { id: archived.candidateId, decision: "expired", reject_reason: "product_archived" },
      ]),
    );
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
    expect(log.events("screen_done")).toEqual([
      { event: "screen_done", listing_id: paused.listingId, decision: "expired", reason: "product_paused" },
      { event: "screen_done", listing_id: archived.listingId, decision: "expired", reason: "product_archived" },
    ]);
  });

  it("expires a candidate whose key names no product (a segment never imported), without a throw, a claim or a call", async () => {
    const arranged = await arrangeEnriched(db.admin);
    await db.admin.query("TRUNCATE app.product, app.product_source, app.product_revision, app.search, app.search_product CASCADE");
    const { claude, screen, job, log } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([{ decision: "expired", reject_reason: "unknown_segment" }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
    expect(log.events("screen_done")).toEqual([
      { event: "screen_done", listing_id: arranged.listingId, decision: "expired", reason: "unknown_segment" },
    ]);
  });

  it("expires a candidate whose segment key this release does not know, without a throw, a claim or a call", async () => {
    const arranged = await arrangeEnriched(db.admin);
    // A product key as v2 writes it.
    await db.admin.query("UPDATE app.candidate SET segment = 'p_k3x9ab2cde' WHERE id = $1", [arranged.candidateId]);
    const { claude, screen, job, log } = setup();

    await screen({ listingId: arranged.listingId }, job());

    expect(claude.requests).toEqual([]);
    expect(await rows("SELECT decision, reject_reason FROM app.candidate")).toEqual([
      { decision: "expired", reject_reason: "unknown_segment" },
    ]);
    expect(await rows("SELECT count(*)::int AS n FROM app.screening")).toEqual([{ n: 0 }]);
    expect(await rows("SELECT count(*)::int AS n FROM app.alert")).toEqual([{ n: 0 }]);
    expect(await listingsToScreen(db.admin, PROMPT_VERSION, new Date(NOW.getTime() + 11 * 60_000), 10)).toEqual([]);
    expect(log.events("screen_done")).toEqual([
      { event: "screen_done", listing_id: arranged.listingId, decision: "expired", reason: "unknown_segment" },
    ]);
  });
});

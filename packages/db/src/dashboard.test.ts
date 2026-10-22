import type pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { alertsPage, blockedPage, candidatesPage, overviewPage, pricesPage, rejectionsPage, screeningsPage } from "./dashboard.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Section 8.2. Every query runs as role dashboard, with only the grants of migration 0005.

let database: TestDatabase;
let dashboard: pg.PoolClient;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  dashboard = await database.pool.connect();
  await dashboard.query("SET ROLE dashboard");
});

afterAll(async () => {
  dashboard.release();
  await database.drop();
});

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const HOUR = 3600;
const q = (text: string, values: unknown[] = []) => database.pool.query(text, values);

describe("overviewPage", () => {
  it("shows the worker, each feed's last poll and failures, sweeps, quota, Claude, email and the last purge", async () => {
    await q("UPDATE app.feed SET enabled = true WHERE id IN ('gpu', 'ram')");
    await q(
      "INSERT INTO app.worker_status (git_sha, started_at, heartbeat_at, smtp_configured, claude_configured) VALUES ('abc', $1, $2, false, true)",
      [ago(HOUR), ago(5)],
    );
    await q("INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 'gpu', 'baseline', $2, $2)", [
      "a".repeat(64),
      ago(HOUR),
    ]);
    const run = (feed: string, startedAgo: number, status: string, extra = "") =>
      q(
        `INSERT INTO app.poll_run (feed_id, kind, started_at, finished_at, status, items, new_items, candidates, warning_ids, cap_reached${extra === "" ? "" : ", error_kind"})
         VALUES ($1, 'poll', $2, ${status === "running" ? "NULL" : "$2"}, $3, 200, 10, 1, '{12001}', $4${extra === "" ? "" : ", $5"})`,
        extra === "" ? [feed, ago(startedAgo), status, startedAgo === 7200] : [feed, ago(startedAgo), status, false, extra],
      );
    await run("gpu", 7200, "ok");
    await run("gpu", 600, "error", "timeout");
    await run("gpu", 300, "error", "timeout");
    await run("gpu", 60, "ok");
    await run("ram", 400, "error", "network");
    await run("ram", 360, "running");
    await q("INSERT INTO app.poll_run (feed_id, segment, kind, started_at, finished_at, status, items, candidates) VALUES ('gpu', 'gpu_3090', 'sweep', $1, $1, 'ok', 50, 0)", [
      ago(HOUR),
    ]);
    await q(
      `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, limit_total, used, used_alert_path, used_standard)
       VALUES ('buy.browse', $1, $2, 5000, 120, 6, 114)`,
      [ago(10 * HOUR), new Date(NOW.getTime() + 14 * HOUR * 1000)],
    );
    await q(
      `INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls)
       VALUES ('2026-10-21T10:00:00Z', 'buy.browse', 'poll', 100), ('2026-10-21T11:00:00Z', 'buy.browse', 'poll', 14),
              ('2026-10-21T11:00:00Z', 'buy.browse', 'get_item', 6), ('2026-10-20T21:00:00Z', 'buy.browse', 'poll', 50)`,
    );
    await q("INSERT INTO app.llm_usage_daily (day_berlin, calls, reserved_microusd, spent_microusd) VALUES ('2026-10-21', 3, 62000, 41000)");
    await q(
      `INSERT INTO app.screening (item_key, prompt_version, model, status, failure_code, created_at)
       VALUES ($1, 'v', 'm', 'failed', 'timeout', $3), ($2, 'v', 'm', 'skipped', 'cap_reached', $3)`,
      ["b".repeat(64), "c".repeat(64), ago(HOUR)],
    );
    await q(
      `INSERT INTO app.alert_delivery (alert_id, recipient, status, hold_reason, next_attempt_at, sent_at, attempt, created_at)
       VALUES (uuidv7(), 'r', 'pending', 'smtp_not_configured', $1, NULL, 0, $1),
              (uuidv7(), 'r', 'pending', 'smtp_not_configured', $1, NULL, 0, $1),
              (uuidv7(), 'r', 'sent', NULL, $1, $1, 1, $1),
              (uuidv7(), 'r', 'failed', NULL, $1, NULL, 5, $1)`,
      [ago(HOUR)],
    );
    await q("INSERT INTO app.purge_run (started_at, finished_at, status, counts) VALUES ($1, $1, 'ok', '{\"listing\": 2}')", [ago(600)]);

    const page = await overviewPage(dashboard, NOW);

    expect(page.worker).toEqual({ gitSha: "abc", startedAt: ago(HOUR), heartbeatAt: ago(5), smtpConfigured: false, claudeConfigured: true });
    expect(page.feeds).toEqual([
      {
        id: "gpu",
        enabled: true,
        baselineDone: true,
        lastPoll: { startedAt: ago(60), status: "ok", stale: false, items: 200, newItems: 10, candidates: 1, warningIds: [12001] },
        failedInRow: 0,
        capReachedLast24h: 1,
      },
      {
        id: "ram",
        enabled: true,
        baselineDone: false,
        lastPoll: { startedAt: ago(360), status: "error", stale: true, items: 200, newItems: 10, candidates: 1, warningIds: [12001] },
        failedInRow: 2,
        capReachedLast24h: 0,
      },
      { id: "pc", enabled: false, baselineDone: false, lastPoll: null, failedInRow: 0, capReachedLast24h: 0 },
    ]);
    expect(page.sweeps.find((s) => s.segment === "gpu_3090")).toEqual({
      segment: "gpu_3090",
      lastSweep: { startedAt: ago(HOUR), status: "ok", stale: false, items: 50, candidates: 0 },
    });
    expect(page.sweeps.find((s) => s.segment === "pc_4090")).toEqual({ segment: "pc_4090", lastSweep: null });
    expect(page.quota).toEqual([
      { resource: "buy.browse", windowStart: ago(10 * HOUR), windowEnd: new Date(NOW.getTime() + 14 * HOUR * 1000), limitTotal: 5000, used: 120, usedAlertPath: 6, usedStandard: 114 },
    ]);
    expect(page.callsToday).toEqual([
      { resource: "buy.browse", purpose: "get_item", calls: 6 },
      { resource: "buy.browse", purpose: "poll", calls: 114 },
    ]);
    expect(page.claudeToday).toEqual({
      day: "2026-10-21",
      calls: 3,
      reservedMicrousd: 62000,
      spentMicrousd: 41000,
      failures: [
        { code: "cap_reached", count: 1 },
        { code: "timeout", count: 1 },
      ],
      pausedUntil: null,
    });
    expect(page.email).toEqual({ pending: [{ holdReason: "smtp_not_configured", count: 2 }], sent24h: 1, failed24h: 1, pausedUntil: null });
    expect(page.lastPurge).toEqual({ startedAt: ago(600), finishedAt: ago(600), status: "ok", counts: { listing: 2 } });
  });
});

// A candidate with its listing. contentExpiresAt in the past means the content is gone.
async function candidate(n: number, input: { segment: string; feed: string; landed: number | null; price: number; totalGb?: number; contentAgo: number; createdAgo: number }) {
  const itemKey = n.toString(16).padStart(64, "0");
  const listing = await q(
    `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at, last_confirmed_at, content_expires_at)
     VALUES ($1, 1, 'v1|1|0', $2, $3, $4, $5, $5, $6) RETURNING id`,
    [itemKey, `${1000 + n}`, input.feed, input.segment, ago(input.createdAgo), ago(input.contentAgo)],
  );
  const listingId = (listing.rows[0] as { id: string }).id;
  await q(
    "INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at) VALUES ($1, 'item', $2, $3, $4)",
    [listingId, `Title ${n}`, ago(input.createdAgo), ago(input.contentAgo)],
  );
  const inserted = await q(
    `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_cents, landed_cents, shipping_known,
       total_gb, rule_version, flags, created_at)
     VALUES ($1, $2, $3, $4, 'poll', $5, $6, $7, $8, $9, 1, '{best_offer}', $10) RETURNING id`,
    [itemKey, listingId, input.feed, input.segment, input.price, input.landed === null ? null : input.landed - input.price, input.landed, input.landed !== null, input.totalGb ?? null, ago(input.createdAgo)],
  );
  return { itemKey, listingId, candidateId: (inserted.rows[0] as { id: string }).id };
}

describe("candidatesPage", () => {
  it("lists the newest candidates with title and link only while content exists, % of max, verdict, and today's counts per segment", async () => {
    const shown = await candidate(101, { segment: "gpu_3090", feed: "gpu", price: 45900, landed: 48900, contentAgo: -HOUR, createdAgo: 120 });
    await candidate(102, { segment: "ram_ddr5", feed: "ram", price: 16500, landed: null, totalGb: 32, contentAgo: 60, createdAgo: 60 });
    await q("INSERT INTO app.screening (item_key, prompt_version, model, status, verdict, created_at) VALUES ($1, 'v', 'm', 'done', 'pass', $2)", [
      shown.itemKey,
      ago(100),
    ]);
    await q(
      `INSERT INTO app.seen_item (item_key, key_version, feed_id, segment, outcome, first_seen_at, last_seen_at)
       VALUES ($1, 1, 'gpu', 'gpu_3090', 'over_cap', $3, $3), ($2, 1, 'gpu', 'gpu_3090', 'too_old', $3, $3)`,
      ["d".repeat(64), "e".repeat(64), ago(HOUR)],
    );

    const page = await candidatesPage(dashboard, NOW);

    expect(page.candidates.slice(0, 2)).toEqual([
      {
        createdAt: ago(60),
        segment: "ram_ddr5",
        title: null,
        priceCents: 16500,
        shippingCents: null,
        landedCents: null,
        percentOfMax: 92,
        flags: ["best_offer"],
        decision: "pending",
        rejectReason: null,
        verdict: null,
        legacyItemId: null,
      },
      {
        createdAt: ago(120),
        segment: "gpu_3090",
        title: "Title 101",
        priceCents: 45900,
        shippingCents: 3000,
        landedCents: 48900,
        percentOfMax: 94,
        flags: ["best_offer"],
        decision: "pending",
        rejectReason: null,
        verdict: "pass",
        legacyItemId: "1101",
      },
    ]);
    expect(page.today.find((row) => row.segment === "gpu_3090")).toEqual({ segment: "gpu_3090", candidates: 1, cap: 150, overCap: 1, tooOld: 1 });
    expect(page.today.find((row) => row.segment === "ram_ddr5")).toEqual({ segment: "ram_ddr5", candidates: 1, cap: 150, overCap: 0, tooOld: 0 });
  });
});

describe("alertsPage, blockedPage and screeningsPage", () => {
  it("list alerts with their delivery, blocked alerts with signals and reason while content exists, and screenings", async () => {
    const blocked = await candidate(201, { segment: "gpu_4090", feed: "gpu", price: 65000, landed: 66000, contentAgo: -HOUR, createdAgo: 30 });
    const screening = await q(
      `INSERT INTO app.screening (item_key, prompt_version, model, status, verdict, product_match, risk_flags, code_signals,
         request_bytes, input_tokens, output_tokens, cost_microusd, latency_ms, created_at)
       VALUES ($1, 'v', 'claude-sonnet-5-5', 'done', 'block', 'match', '{off_ebay_payment}', '{iban_present}', 4000, 2000, 700, 11000, 5000, $2)
       RETURNING id`,
      [blocked.itemKey, ago(25)],
    );
    const screeningId = (screening.rows[0] as { id: string }).id;
    await q("INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, 'Asks for a bank transfer.', $2)", [
      screeningId,
      new Date(NOW.getTime() + HOUR * 1000),
    ]);
    const alert = await q(
      `INSERT INTO app.alert (item_key, candidate_id, screening_id, segment, final_verdict, model_verdict, blocked_by_code, screened,
         flags, landed_cents, rule_version, buyer_profile, created_at)
       VALUES ($1, $2, $3, 'gpu_4090', 'block', 'block', true, true, '{best_offer}', 66000, 1, 'company', $4) RETURNING id`,
      [blocked.itemKey, blocked.candidateId, screeningId, ago(20)],
    );
    const passed = await q(
      `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, landed_cents, rule_version, buyer_profile, created_at)
       VALUES ($1, $2, 'gpu_3090', 'caution', false, false, 48900, 1, 'company', $3) RETURNING id`,
      ["f".repeat(64), blocked.candidateId, ago(10)],
    );
    await q(
      `INSERT INTO app.alert_delivery (alert_id, recipient, status, hold_reason, attempt, next_attempt_at, last_error_code, created_at)
       VALUES ($1, 'r', 'pending', 'rate_limit', 1, $2, '421', $2)`,
      [(passed.rows[0] as { id: string }).id, ago(10)],
    );

    const alerts = await alertsPage(dashboard, NOW);
    const blockedRows = await blockedPage(dashboard, NOW);
    const screenings = await screeningsPage(dashboard, NOW);

    expect(alerts.slice(0, 2)).toEqual([
      {
        createdAt: ago(10),
        segment: "gpu_3090",
        landedCents: 48900,
        finalVerdict: "caution",
        modelVerdict: null,
        blockedByCode: false,
        screened: false,
        deliveryStatus: "pending",
        holdReason: "rate_limit",
        attempt: 1,
        lastErrorCode: "421",
        sentAt: null,
      },
      {
        createdAt: ago(20),
        segment: "gpu_4090",
        landedCents: 66000,
        finalVerdict: "block",
        modelVerdict: "block",
        blockedByCode: true,
        screened: true,
        deliveryStatus: null,
        holdReason: null,
        attempt: null,
        lastErrorCode: null,
        sentAt: null,
      },
    ]);
    expect(blockedRows).toEqual([
      {
        alertId: (alert.rows[0] as { id: string }).id,
        createdAt: ago(20),
        segment: "gpu_4090",
        landedCents: 66000,
        flags: ["best_offer"],
        riskFlags: ["off_ebay_payment"],
        codeSignals: ["iban_present"],
        blockedByCode: true,
        reason: "Asks for a bank transfer.",
        legacyItemId: "1201",
      },
    ]);
    expect(screenings[0]).toEqual({
      createdAt: ago(25),
      status: "done",
      verdict: "block",
      riskFlags: ["off_ebay_payment"],
      failureCode: null,
      requestBytes: 4000,
      inputTokens: 2000,
      outputTokens: 700,
      costMicrousd: 11000,
      latencyMs: 5000,
      model: "claude-sonnet-5-5",
    });
  });
});

describe("rejectionsPage and pricesPage", () => {
  it("count the last 24 h by feed and reason with the unexpired sample, and read prices per segment and window", async () => {
    await q("TRUNCATE app.seen_item, app.price_sample, app.poll_run");
    await q(
      `INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at)
       SELECT lpad(to_hex(n), 64, '0'), 1, 'gpu', CASE WHEN n <= 3 THEN 'wrong_model' ELSE 'above_max' END, $1, $1
         FROM generate_series(1, 5) n`,
      [ago(HOUR)],
    );
    await q("INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 'ram', 'ram_server', $2, $2)", [
      "9".repeat(64),
      ago(25 * HOUR),
    ]);
    await q(
      `INSERT INTO ebay_live.classifier_sample (feed_id, segment, title, landed_cents, outcome, reason, seen_at, expires_at)
       VALUES ('gpu', NULL, 'RTX 3080 10GB', 30000, 'rejected', 'wrong_model', $1, $2),
              ('gpu', NULL, 'expired title', 30000, 'rejected', 'wrong_model', $3, $4)`,
      [ago(HOUR), new Date(NOW.getTime() + 5 * HOUR * 1000), ago(7 * HOUR), ago(HOUR)],
    );
    await q(
      `INSERT INTO app.price_sample (segment, feed_id, price_cents, shipping_cents, landed_cents, seen_at)
       SELECT 'gpu_3090', 'gpu', 40000 + (n - 1) * 1000 - 500, 500, 40000 + (n - 1) * 1000, $1 FROM generate_series(1, 20) n`,
      [ago(2 * HOUR)],
    );
    await q("INSERT INTO app.poll_run (feed_id, kind, baseline, started_at, finished_at, status) VALUES ('gpu', 'poll', true, $1, $1, 'ok')", [
      ago(HOUR),
    ]);

    const rejections = await rejectionsPage(dashboard, NOW);
    const prices = await pricesPage(dashboard, NOW);

    expect(rejections.counts).toEqual([
      { feedId: "gpu", outcome: "above_max", count: 2 },
      { feedId: "gpu", outcome: "wrong_model", count: 3 },
    ]);
    expect(rejections.samples).toEqual([
      { feedId: "gpu", segment: null, title: "RTX 3080 10GB", landedCents: 30000, outcome: "rejected", reason: "wrong_model", seenAt: ago(HOUR) },
    ]);
    const gpu3090 = prices.find((row) => row.segment === "gpu_3090");
    expect(gpu3090?.current).toEqual({ kind: "per_item", maxLandedCents: 52000, floorCents: 26000 });
    expect(gpu3090?.windows.map((w) => [w.window, w.since, w.stats.n, w.suggestion])).toEqual([
      ["since_baseline", ago(HOUR), 0, { kind: "none", reason: "too_few" }],
      ["last_24h", ago(24 * HOUR), 20, { kind: "per_item", maxLandedCents: 39000, floorCents: 19000 }],
      ["last_7d", ago(7 * 24 * HOUR), 20, { kind: "per_item", maxLandedCents: 39000, floorCents: 19000 }],
    ]);
    expect(gpu3090?.windows[1]?.stats).toMatchObject({ p25: 44750, p50: 49500, p75: 54250 });
    expect(prices.map((row) => row.segment)).toEqual(["gpu_3090", "gpu_3090ti", "gpu_4090", "ram_ddr4", "ram_ddr5", "pc_4090"]);
  });
});

import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { runPurge } from "./purge.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// Section 7.3. Every purge here runs as role worker, the role the worker connects as.

let database: TestDatabase;
let worker: pg.PoolClient;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
  worker = await database.pool.connect();
  await worker.query("SET ROLE worker");
});

afterAll(async () => {
  worker.release();
  await database.drop();
});

const NOW = new Date("2026-10-21T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const HOUR = 3600;
const DAY = 24 * HOUR;
const clock = { now: () => NOW };
const key = (n: number) => n.toString(16).padStart(64, "0");

async function count(table: string): Promise<number> {
  const result = await database.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return result.rows[0]?.n ?? 0;
}

// A listing that stays (confirmed now, no end), with content expiring at contentExpiresAt.
async function listingWithContent(n: number, contentExpiresAt: Date): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    `INSERT INTO ebay_live.listing (item_key, key_version, item_id, legacy_item_id, feed_id, segment, first_seen_at,
       last_confirmed_at, content_expires_at)
     VALUES ($1, 1, 'v1|1|0', '1', 'gpu', 'gpu_3090', $2, $2, $3) RETURNING id`,
    [key(n), NOW, contentExpiresAt],
  );
  const id = result.rows[0]?.id ?? "";
  await database.pool.query(
    `INSERT INTO ebay_live.listing_content (listing_id, source, title, fetched_at, content_expires_at)
     VALUES ($1, 'summary', 'RTX 3090', $2, $3)`,
    [id, ago(HOUR), contentExpiresAt],
  );
  return id;
}

beforeEach(async () => {
  await database.pool.query(
    `TRUNCATE ebay_live.listing, ebay_live.listing_content, ebay_live.classifier_sample, ebay_live.screening_text,
       ebay_live.alert_message, app.seen_item, app.price_sample, app.poll_run, app.candidate, app.screening, app.alert,
       app.alert_delivery, app.llm_usage_daily, app.purge_run`,
  );
});

describe("runPurge, content", () => {
  it("deletes content at its expiry and keeps content that expires a second later", async () => {
    await listingWithContent(1, NOW);
    await listingWithContent(2, new Date(NOW.getTime() + 1000));
    for (const [expiresAt, n] of [[NOW, 1], [new Date(NOW.getTime() + 1000), 2]] as const) {
      await database.pool.query(
        `INSERT INTO ebay_live.classifier_sample (feed_id, title, outcome, reason, seen_at, expires_at)
         VALUES ('gpu', 't', 'rejected', 'wrong_model', $1, $2)`,
        [ago(6 * HOUR), expiresAt],
      );
      await database.pool.query("INSERT INTO ebay_live.screening_text (screening_id, reason, expires_at) VALUES ($1, 'r', $2)", [
        `00000000-0000-7000-8000-00000000000${n}`,
        expiresAt,
      ]);
      await database.pool.query(
        "INSERT INTO ebay_live.alert_message (delivery_id, subject, text_body, html_body, expires_at) VALUES ($1, 's', 't', 'h', $2)",
        [`00000000-0000-7000-8000-00000000000${n}`, expiresAt],
      );
    }

    const counts = await runPurge(worker, clock);

    expect(counts).toMatchObject({ listing_content: 1, classifier_sample: 1, screening_text: 1, alert_message: 1 });
    for (const table of ["ebay_live.listing_content", "ebay_live.classifier_sample", "ebay_live.screening_text", "ebay_live.alert_message"]) {
      expect(await count(table), table).toBe(1);
    }
    expect(await count("ebay_live.listing")).toBe(2);
  });
});

describe("runPurge, listings", () => {
  it("takes a listing unconfirmed for 48 h or ended as gone and deletes it with its content; 47 h stays", async () => {
    const stays = await listingWithContent(10, new Date(NOW.getTime() + HOUR * 1000));
    const unconfirmed = await listingWithContent(11, new Date(NOW.getTime() + HOUR * 1000));
    const ended = await listingWithContent(12, new Date(NOW.getTime() + HOUR * 1000));
    const notFound = await listingWithContent(13, new Date(NOW.getTime() + HOUR * 1000));
    await database.pool.query("UPDATE ebay_live.listing SET last_confirmed_at = $2 WHERE id = $1", [stays, ago(47 * HOUR)]);
    await database.pool.query("UPDATE ebay_live.listing SET last_confirmed_at = $2 WHERE id = $1", [unconfirmed, ago(48 * HOUR)]);
    await database.pool.query("UPDATE ebay_live.listing SET item_end_at = $2 WHERE id = $1", [ended, NOW]);
    await database.pool.query("UPDATE ebay_live.listing SET gone_at = $2, gone_reason = 'not_found' WHERE id = $1", [notFound, ago(60)]);

    const counts = await runPurge(worker, clock);

    expect(counts).toMatchObject({ listing_ended: 1, listing_unconfirmed: 1, listing: 3 });
    const left = await database.pool.query<{ id: string }>("SELECT listing_id AS id FROM ebay_live.listing_content");
    expect(left.rows).toEqual([{ id: stays }]);
    expect(await count("ebay_live.listing")).toBe(1);
  });
});

describe("runPurge, prices and deliveries", () => {
  it("sets prices to NULL at day 30 and keeps the other columns, and expires a pending delivery without its message", async () => {
    for (const [n, createdAt] of [[20, ago(30 * DAY)], [21, ago(30 * DAY - 1)]] as const) {
      await database.pool.query(
        `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, price_cents, shipping_cents, landed_cents,
           shipping_known, total_gb, rule_version, created_at)
         VALUES ($1, $2, 'ram', 'ram_ddr4', 'poll', 9000, 500, 9500, true, 32, 2, $3)`,
        [key(n), `00000000-0000-7000-8000-0000000000${n}`, createdAt],
      );
      await database.pool.query(
        `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, price_cents,
           shipping_cents, landed_cents, rule_version, buyer_profile, created_at)
         VALUES ($1, $2, 'ram_ddr4', 'pass', false, true, 9000, 500, 9500, 2, 'company', $3)`,
        [key(n), `00000000-0000-7000-8000-0000000000${n}`, createdAt],
      );
    }
    const delivery = async (n: number) => {
      const result = await database.pool.query<{ id: string }>(
        `INSERT INTO app.alert_delivery (alert_id, recipient, next_attempt_at, created_at)
         VALUES ($1, 'owner@example.test', $2, $2) RETURNING id`,
        [`00000000-0000-7000-8000-0000000000${n}`, ago(60)],
      );
      return result.rows[0]?.id ?? "";
    };
    const withoutMessage = await delivery(30);
    const withMessage = await delivery(31);
    await database.pool.query(
      "INSERT INTO ebay_live.alert_message (delivery_id, subject, text_body, html_body, expires_at) VALUES ($1, 's', 't', 'h', $2)",
      [withMessage, new Date(NOW.getTime() + HOUR * 1000)],
    );

    const counts = await runPurge(worker, clock);

    expect(counts).toMatchObject({ candidate_prices: 1, alert_prices: 1, delivery_expired: 1 });
    const candidates = await database.pool.query(
      "SELECT item_key, price_cents, shipping_cents, landed_cents, total_gb, rule_version, shipping_known FROM app.candidate ORDER BY item_key",
    );
    expect(candidates.rows).toEqual([
      { item_key: key(20), price_cents: null, shipping_cents: null, landed_cents: null, total_gb: 32, rule_version: 2, shipping_known: true },
      { item_key: key(21), price_cents: 9000, shipping_cents: 500, landed_cents: 9500, total_gb: 32, rule_version: 2, shipping_known: true },
    ]);
    const alerts = await database.pool.query("SELECT item_key, landed_cents, final_verdict FROM app.alert ORDER BY item_key");
    expect(alerts.rows).toEqual([
      { item_key: key(20), landed_cents: null, final_verdict: "pass" },
      { item_key: key(21), landed_cents: 9500, final_verdict: "pass" },
    ]);
    const deliveries = await database.pool.query("SELECT id, status FROM app.alert_delivery ORDER BY status");
    expect(deliveries.rows).toEqual([
      { id: withoutMessage, status: "expired" },
      { id: withMessage, status: "pending" },
    ]);
  });
});

describe("runPurge, lifetimes", () => {
  it("deletes rows at the end of their lifetime, keeps younger ones, never touches the deferred tables, and records the run", async () => {
    const pair = async (age: number, insert: (at: Date, n: number) => Promise<unknown>) => {
      await insert(ago(age), 1);
      await insert(ago(age - 1), 2);
    };
    const uuid = (n: number, table: number) => `00000000-0000-7000-8000-${String(table * 100 + n).padStart(12, "0")}`;
    await pair(90 * DAY, (at, n) =>
      database.pool.query(
        "INSERT INTO app.seen_item (item_key, key_version, feed_id, outcome, first_seen_at, last_seen_at) VALUES ($1, 1, 'gpu', 'baseline', $2, $2)",
        [key(40 + n), at],
      ),
    );
    await pair(30 * DAY, (at) =>
      database.pool.query("INSERT INTO app.price_sample (segment, feed_id, price_cents, seen_at) VALUES ('gpu_3090', 'gpu', 1, $1)", [at]),
    );
    await pair(30 * DAY, (at) =>
      database.pool.query("INSERT INTO app.poll_run (feed_id, kind, started_at, status) VALUES ('gpu', 'poll', $1, 'running')", [at]),
    );
    await pair(30 * DAY, (at) =>
      database.pool.query("INSERT INTO app.purge_run (started_at, finished_at, status) VALUES ($1, $1, 'ok')", [at]),
    );
    await pair(180 * DAY, (at, n) =>
      database.pool.query(
        "INSERT INTO app.screening (item_key, prompt_version, model, status, created_at) VALUES ($1, 'v', 'm', 'skipped', $2)",
        [key(50 + n), at],
      ),
    );
    await pair(180 * DAY, (at, n) =>
      database.pool.query(
        `INSERT INTO app.candidate (item_key, listing_id, feed_id, segment, source, shipping_known, rule_version, created_at)
         VALUES ($1, $2, 'gpu', 'gpu_3090', 'poll', true, 1, $3)`,
        [key(60 + n), uuid(n, 6), at],
      ),
    );
    await pair(180 * DAY, (at, n) =>
      database.pool.query(
        `INSERT INTO app.alert (item_key, candidate_id, segment, final_verdict, blocked_by_code, screened, rule_version, buyer_profile, created_at)
         VALUES ($1, $2, 'gpu_3090', 'pass', false, true, 1, 'company', $3)`,
        [key(70 + n), uuid(n, 7), at],
      ),
    );
    await pair(180 * DAY, (at, n) =>
      database.pool.query(
        "INSERT INTO app.alert_delivery (alert_id, recipient, status, next_attempt_at, sent_at, attempt, created_at) VALUES ($1, 'r', 'sent', $2, $2, 1, $2)",
        [uuid(n, 8), at],
      ),
    );
    // Berlin day 2025-10-20 is more than a year before 2026-10-21 (Berlin); 2025-10-21 is not.
    await database.pool.query("INSERT INTO app.llm_usage_daily (day_berlin, calls) VALUES ('2025-10-20', 1), ('2025-10-21', 1)");
    const old = ago(400 * DAY);
    await database.pool.query(
      "INSERT INTO app.deletion_event (notification_id, topic, event_date, publish_attempt_count, created_at) VALUES ('n', 't', $1, 1, $1)",
      [old],
    );
    await database.pool.query("INSERT INTO app.audit_event (at, actor, action) VALUES ($1, 'system:cli', 'x')", [old]);
    await database.pool.query(
      "INSERT INTO app.api_usage_hourly (hour_utc, resource, purpose, calls) VALUES (date_trunc('hour', $1::timestamptz), 'buy.browse', 'poll', 1)",
      [old],
    );
    await database.pool.query(
      "INSERT INTO app.ebay_quota_window (resource, window_start, window_end) VALUES ('buy.browse', $1, $2)",
      [old, new Date(old.getTime() + DAY * 1000)],
    );

    const counts = await runPurge(worker, clock);

    expect(counts).toMatchObject({
      seen_item: 1,
      price_sample: 1,
      poll_run: 1,
      purge_run: 1,
      screening: 1,
      candidate: 1,
      alert: 1,
      alert_delivery: 1,
      llm_usage_daily: 1,
    });
    for (const table of ["seen_item", "price_sample", "poll_run", "screening", "candidate", "alert", "alert_delivery", "llm_usage_daily"]) {
      expect(await count(`app.${table}`), table).toBe(1);
    }
    for (const table of ["deletion_event", "audit_event", "api_usage_hourly", "ebay_quota_window"]) {
      expect(await count(`app.${table}`), table).toBe(1);
    }
    const runs = await database.pool.query<{ started_at: Date; status: string; counts: Record<string, number> }>(
      "SELECT started_at, status, counts FROM app.purge_run ORDER BY started_at DESC LIMIT 1",
    );
    expect(runs.rows).toEqual([{ started_at: NOW, status: "ok", counts }]);
  });
});

describe("runPurge, batches", () => {
  it("deletes 12,000 expired rows in 3 statements of at most 5,000 rows", async () => {
    await database.pool.query(
      `INSERT INTO ebay_live.classifier_sample (feed_id, title, outcome, reason, seen_at, expires_at)
       SELECT 'gpu', 't', 'rejected', 'wrong_model', $1, $1 FROM generate_series(1, 12000)`,
      [ago(60)],
    );
    const statements: string[] = [];
    const counting = {
      query: ((text: string, values?: unknown[]) => {
        statements.push(text);
        return worker.query(text, values);
      }) as typeof worker.query,
    };

    const counts = await runPurge(counting, clock);

    expect(counts["classifier_sample"]).toBe(12_000);
    expect(statements.filter((text) => text.startsWith("DELETE FROM ebay_live.classifier_sample"))).toHaveLength(3);
    expect(await count("ebay_live.classifier_sample")).toBe(0);
  });
});

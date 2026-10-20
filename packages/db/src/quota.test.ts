import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { QuotaClockSkewError, reserveEbayCall, type ReserveEbayCallInput } from "./quota.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

// p_now must be within 300 s of the database clock, so every time here is relative to the real clock.

const HOUR = 3_600_000;

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("TRUNCATE app.ebay_quota_window, app.api_usage_hourly");
});

function call(overrides: Partial<ReserveEbayCallInput> = {}): ReserveEbayCallInput {
  return {
    resource: "buy.browse",
    callClass: "standard",
    purpose: "contract",
    minLeft: 0,
    now: new Date(),
    ...overrides,
  };
}

type WindowRow = {
  window_start: Date;
  window_end: Date;
  limit_total: number;
  used: number;
  used_alert_path: number;
  used_standard: number;
  ebay_offset: number;
};

async function windows(): Promise<WindowRow[]> {
  const result = await database.pool.query<WindowRow>(
    `SELECT window_start, window_end, limit_total, used, used_alert_path, used_standard, ebay_offset
       FROM app.ebay_quota_window ORDER BY window_start`,
  );
  return result.rows;
}

async function usage(): Promise<{ hour_utc: Date; resource: string; purpose: string; calls: number }[]> {
  const result = await database.pool.query<{ hour_utc: Date; resource: string; purpose: string; calls: number }>(
    "SELECT hour_utc, resource, purpose, calls FROM app.api_usage_hourly ORDER BY hour_utc, purpose",
  );
  return result.rows;
}

function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

async function presetWindow(
  start: Date,
  end: Date,
  fields: { limitTotal?: number; ebayOffset?: number; resource?: string } = {},
): Promise<void> {
  await database.pool.query(
    `INSERT INTO app.ebay_quota_window (resource, window_start, window_end, limit_total, ebay_offset)
     VALUES ($1, $2, $3, $4, $5)`,
    [fields.resource ?? "buy.browse", start, end, fields.limitTotal ?? 5000, fields.ebayOffset ?? 0],
  );
}

// A window from an hour ago to 23 hours ahead, so a test never crosses its end.
async function presetCurrentWindow(fields: { limitTotal?: number; ebayOffset?: number } = {}): Promise<void> {
  const now = Date.now();
  await presetWindow(new Date(now - HOUR), new Date(now + 23 * HOUR), fields);
}

function count<T>(values: T[], value: T): number {
  return values.filter((candidate) => candidate === value).length;
}

describe("reserve_ebay_call", () => {
  it("opens today's UTC-midnight window on the first call and counts the usage", async () => {
    const now = new Date();

    const result = await reserveEbayCall(database.pool, call({ now }));

    expect(result).toBe("ok");
    const start = utcMidnight(now);
    expect(await windows()).toEqual([
      {
        window_start: start,
        window_end: new Date(start.getTime() + 24 * HOUR),
        limit_total: 5000,
        used: 1,
        used_alert_path: 0,
        used_standard: 1,
        ebay_offset: 0,
      },
    ]);
    expect(await usage()).toEqual([
      {
        hour_utc: new Date(Math.floor(now.getTime() / HOUR) * HOUR),
        resource: "buy.browse",
        purpose: "contract",
        calls: 1,
      },
    ]);
  });

  it("never overruns the floor under concurrent callers in two processes (ADR 0007)", async () => {
    await presetCurrentWindow({ limitTotal: 300 });
    const second = new pg.Pool({ connectionString: database.url });
    const pools = [database.pool, second];
    try {
      const standard = await Promise.all(
        Array.from({ length: 300 }, (_, i) =>
          reserveEbayCall(pools[i % 2] ?? database.pool, call({ minLeft: 100, now: new Date() })),
        ),
      );
      const alertPath = await Promise.all(
        Array.from({ length: 150 }, (_, i) =>
          reserveEbayCall(pools[i % 2] ?? database.pool, call({ callClass: "alert-path", minLeft: 0, now: new Date() })),
        ),
      );

      expect([count(standard, "ok"), count(standard, "pool")]).toEqual([200, 100]);
      expect([count(alertPath, "ok"), count(alertPath, "pool")]).toEqual([100, 50]);
      expect(await windows()).toMatchObject([{ used: 300, used_standard: 200, used_alert_path: 100 }]);
      expect((await usage()).reduce((sum, row) => sum + row.calls, 0)).toBe(300);
    } finally {
      await second.end();
    }
  });

  it("refuses standard calls 50 calls earlier with an ebay_offset of 50", async () => {
    await presetCurrentWindow({ limitTotal: 300, ebayOffset: 50 });

    const results: string[] = [];
    for (let i = 0; i < 200; i++) results.push(await reserveEbayCall(database.pool, call({ minLeft: 100 })));

    expect(results.indexOf("pool")).toBe(150);
    expect(count(results, "ok")).toBe(150);
  });

  it("opens one window for 20 parallel first calls", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => reserveEbayCall(database.pool, call())));

    expect(count(results, "ok")).toBe(20);
    expect(await windows()).toMatchObject([{ used: 20 }]);
  });

  it.each([
    { endedHoursAgo: 1, startsAfterEndHours: 0 },
    { endedHoursAgo: 73, startsAfterEndHours: 72 },
  ])(
    "rolls over to the window aligned to the last window_end (ended $endedHoursAgo h ago)",
    async ({ endedHoursAgo, startsAfterEndHours }) => {
      const now = new Date();
      const end = new Date(now.getTime() - endedHoursAgo * HOUR);
      await presetWindow(new Date(end.getTime() - 24 * HOUR), end, { limitTotal: 1234, ebayOffset: 7 });

      expect(await reserveEbayCall(database.pool, call({ now }))).toBe("ok");

      const start = new Date(end.getTime() + startsAfterEndHours * HOUR);
      expect((await windows()).at(-1)).toEqual({
        window_start: start,
        window_end: new Date(start.getTime() + 24 * HOUR),
        limit_total: 1234,
        used: 1,
        used_alert_path: 0,
        used_standard: 1,
        ebay_offset: 0,
      });
    },
  );

  it("refuses a time before the newest window", async () => {
    const now = new Date();
    await presetWindow(new Date(now.getTime() + HOUR), new Date(now.getTime() + 25 * HOUR));

    await expect(reserveEbayCall(database.pool, call({ now }))).rejects.toThrow(/is before the newest quota window/);
  });

  it("writes nothing when it refuses", async () => {
    await presetCurrentWindow({ limitTotal: 101 });
    expect(await reserveEbayCall(database.pool, call({ minLeft: 100 }))).toBe("ok");
    const windowsBefore = await windows();
    const usageBefore = await usage();

    expect(await reserveEbayCall(database.pool, call({ minLeft: 100 }))).toBe("pool");

    expect(await windows()).toEqual(windowsBefore);
    expect(await usage()).toEqual(usageBefore);
  });

  it.each([
    { args: ["buy.browse", "bulk", "contract", 0], message: /unknown class bulk/ },
    { args: ["buy.browse", "standard", "contract", -1], message: /min_left must be 0 or more/ },
    { args: [null, "standard", "contract", 0], message: /resource, purpose and now are required/ },
  ])("raises on bad arguments: $message", async ({ args, message }) => {
    await expect(
      database.pool.query("SELECT app.reserve_ebay_call($1, $2, $3, $4, $5)", [...args, new Date()]),
    ).rejects.toThrow(message);
    expect(await windows()).toEqual([]);
  });

  it("refuses a window that overlaps another of the same resource (23P01)", async () => {
    const now = Date.now();
    await presetWindow(new Date(now - HOUR), new Date(now + 23 * HOUR));

    await expect(
      presetWindow(new Date(now + 23 * HOUR - 1), new Date(now + 47 * HOUR)),
    ).rejects.toMatchObject({ code: "23P01" });
    await presetWindow(new Date(now + 23 * HOUR), new Date(now + 47 * HOUR));
    await presetWindow(new Date(now), new Date(now + 24 * HOUR), { resource: "buy.other" });
    expect(await windows()).toHaveLength(3);
  });

  it("books on the later of two back-to-back windows at their shared instant", async () => {
    const now = new Date();
    await presetWindow(new Date(now.getTime() - 24 * HOUR), now);
    await presetWindow(now, new Date(now.getTime() + 24 * HOUR));

    expect(await reserveEbayCall(database.pool, call({ now }))).toBe("ok");

    expect((await windows()).map((window) => window.used)).toEqual([0, 1]);
  });

  it("follows a window whose end was moved by UPDATE", async () => {
    const now = Date.now();
    const start = new Date(now - HOUR);
    await presetWindow(start, new Date(now + 23 * HOUR));
    const moveEnd = (end: Date) =>
      database.pool.query("UPDATE app.ebay_quota_window SET window_end = $1 WHERE window_start = $2", [end, start]);

    await moveEnd(new Date(now + HOUR));
    expect(await reserveEbayCall(database.pool, call())).toBe("ok");
    expect((await windows()).map((window) => window.used)).toEqual([1]);

    const newEnd = new Date(Date.now() - 60_000);
    await moveEnd(newEnd);
    expect(await reserveEbayCall(database.pool, call())).toBe("ok");
    expect((await windows()).map((window) => [window.window_start, window.used])).toEqual([
      [start, 1],
      [newEnd, 1],
    ]);
  });

  it.each([400, -400])("refuses a p_now %i s from the database clock with QuotaClockSkewError", async (offset) => {
    const now = new Date(Date.now() + offset * 1000);

    await expect(
      database.pool.query("SELECT app.reserve_ebay_call('buy.browse', 'standard', 'contract', 0, $1)", [now]),
    ).rejects.toMatchObject({ code: "EB001" });
    await expect(reserveEbayCall(database.pool, call({ now }))).rejects.toBeInstanceOf(QuotaClockSkewError);
    expect(await windows()).toEqual([]);
    expect(await usage()).toEqual([]);
  });

  it.each([200, -200])("accepts a p_now %i s from the database clock", async (offset) => {
    const now = new Date(Date.now() + offset * 1000);

    expect(await reserveEbayCall(database.pool, call({ now }))).toBe("ok");
  });

  it("buckets usage by the UTC hour with a Europe/Berlin session", async () => {
    const now = new Date();
    const client = await database.pool.connect();
    try {
      await client.query("SET timezone TO 'Europe/Berlin'");
      await client.query("SELECT app.reserve_ebay_call('buy.browse', 'standard', 'contract', 0, $1)", [now]);
      const result = await client.query<{ matches: boolean }>(
        "SELECT hour_utc = date_trunc('hour', $1::timestamptz, 'UTC') AS matches FROM app.api_usage_hourly",
        [now],
      );

      expect(result.rows).toEqual([{ matches: true }]);
    } finally {
      await client.query("RESET timezone");
      client.release();
    }
    expect((await usage())[0]?.hour_utc).toEqual(new Date(Math.floor(now.getTime() / HOUR) * HOUR));
  });

  it("throws on a result other than ok or pool", async () => {
    const other = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
    try {
      await other.pool.query(
        `CREATE OR REPLACE FUNCTION app.reserve_ebay_call(
           p_resource text, p_class text, p_purpose text, p_min_left integer, p_now timestamptz
         ) RETURNS text LANGUAGE sql AS $$ SELECT 'maybe' $$`,
      );

      await expect(reserveEbayCall(other.pool, call())).rejects.toThrow("reserve_ebay_call returned an unknown result");
    } finally {
      await other.drop();
    }
  });

  it("throws when the database cannot be reached", async () => {
    const closed = new pg.Pool({ connectionString: database.url });
    await closed.end();

    await expect(reserveEbayCall(closed, call())).rejects.toThrow();
  });

  it("has exactly one signature, with five arguments", async () => {
    const result = await database.pool.query<{ args: string }>(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname = 'reserve_ebay_call'`,
    );

    expect(result.rows).toEqual([
      { args: "p_resource text, p_class text, p_purpose text, p_min_left integer, p_now timestamp with time zone" },
    ]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { addHourlyCounts, recordDeletionEvent, recordProbeSeen } from "./deletion.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await database.pool.query("TRUNCATE app.deletion_event, app.deletion_result_hourly, app.api_usage_hourly, app.probe_seen");
});

function event(notificationId: string, publishAttemptCount: number) {
  return {
    notificationId,
    topic: "MARKETPLACE_ACCOUNT_DELETION",
    eventDate: new Date("2026-10-20T09:15:00.250Z"),
    publishAttemptCount,
  };
}

type EventRow = { notification_id: string; topic: string; event_date: Date; publish_attempt_count: number; updated_at: Date };

async function events(): Promise<EventRow[]> {
  const result = await database.pool.query<EventRow>(
    "SELECT notification_id, topic, event_date, publish_attempt_count, updated_at FROM app.deletion_event ORDER BY notification_id",
  );
  return result.rows;
}

describe("recordDeletionEvent", () => {
  it("keeps one row per notification with the highest publish attempt count (A5)", async () => {
    expect(await recordDeletionEvent(database.pool, event("n-1", 1))).toBe("inserted");
    const [first] = await events();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await recordDeletionEvent(database.pool, event("n-1", 3))).toBe("updated");
    expect(await recordDeletionEvent(database.pool, event("n-1", 2))).toBe("updated");

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      notification_id: "n-1",
      topic: "MARKETPLACE_ACCOUNT_DELETION",
      event_date: new Date("2026-10-20T09:15:00.250Z"),
      publish_attempt_count: 3,
    });
    expect(rows[0]?.updated_at.getTime()).toBeGreaterThan(first?.updated_at.getTime() ?? Number.POSITIVE_INFINITY);
  });

  it("ends with one row and count 100 when one notification arrives 100 times at once", async () => {
    const counts = Array.from({ length: 100 }, (_, index) => index + 1).sort(() => Math.random() - 0.5);

    const results = await Promise.all(counts.map((count) => recordDeletionEvent(database.pool, event("n-repeat", count))));

    expect(results.filter((result) => result === "inserted")).toHaveLength(1);
    const rows = await events();
    expect(rows.map((row) => [row.notification_id, row.publish_attempt_count])).toEqual([["n-repeat", 100]]);
  });

  it("writes 1,500 rows for 1,500 distinct notifications", async () => {
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) => recordDeletionEvent(database.pool, event(`n-${index}`, 1))),
    );

    const count = await database.pool.query<{ count: number }>("SELECT count(*)::int AS count FROM app.deletion_event");
    expect(count.rows[0]?.count).toBe(1_500);
  });
});

const HOUR = new Date("2026-10-20T10:00:00Z");
const NEXT_HOUR = new Date("2026-10-20T11:00:00Z");

async function resultCounts(): Promise<{ hour_utc: Date; result: string; notifications: number }[]> {
  const rows = await database.pool.query<{ hour_utc: Date; result: string; notifications: number }>(
    "SELECT hour_utc, result, notifications FROM app.deletion_result_hourly ORDER BY hour_utc, result",
  );
  return rows.rows;
}

async function usageCounts(): Promise<{ hour_utc: Date; resource: string; purpose: string; calls: number }[]> {
  const rows = await database.pool.query<{ hour_utc: Date; resource: string; purpose: string; calls: number }>(
    "SELECT hour_utc, resource, purpose, calls FROM app.api_usage_hourly ORDER BY hour_utc, resource, purpose",
  );
  return rows.rows;
}

describe("addHourlyCounts", () => {
  it("writes both tables and adds to the counts already there", async () => {
    await addHourlyCounts(database.pool, {
      deletionResults: [
        { hourUtc: HOUR, result: "dropped", count: 2 },
        { hourUtc: HOUR, result: "key_rejected", count: 5 },
      ],
      apiUsage: [{ hourUtc: HOUR, resource: "commerce.notification", purpose: "deletion-key", calls: 3 }],
    });
    await addHourlyCounts(database.pool, {
      deletionResults: [
        { hourUtc: HOUR, result: "dropped", count: 1 },
        { hourUtc: NEXT_HOUR, result: "dropped", count: 4 },
      ],
      apiUsage: [
        { hourUtc: HOUR, resource: "commerce.notification", purpose: "deletion-key", calls: 1 },
        { hourUtc: HOUR, resource: "identity.oauth2", purpose: "token", calls: 1 },
      ],
    });

    expect(await resultCounts()).toEqual([
      { hour_utc: HOUR, result: "dropped", notifications: 3 },
      { hour_utc: HOUR, result: "key_rejected", notifications: 5 },
      { hour_utc: NEXT_HOUR, result: "dropped", notifications: 4 },
    ]);
    expect(await usageCounts()).toEqual([
      { hour_utc: HOUR, resource: "commerce.notification", purpose: "deletion-key", calls: 4 },
      { hour_utc: HOUR, resource: "identity.oauth2", purpose: "token", calls: 1 },
    ]);
  });

  it("writes nothing when the api usage rows break a CHECK, because it is one statement", async () => {
    await expect(
      addHourlyCounts(database.pool, {
        deletionResults: [{ hourUtc: HOUR, result: "dropped", count: 1 }],
        apiUsage: [{ hourUtc: HOUR, resource: "identity.oauth2", purpose: "Not A Purpose", calls: 1 }],
      }),
    ).rejects.toMatchObject({ code: "23514", constraint: "api_usage_hourly_purpose_format" });

    expect(await resultCounts()).toEqual([]);
    expect(await usageCounts()).toEqual([]);
  });

  it("sends no statement when both lists are empty", async () => {
    const query = vi.spyOn(database.pool, "query");
    try {
      await addHourlyCounts(database.pool, { deletionResults: [], apiUsage: [] });

      expect(query).not.toHaveBeenCalled();
    } finally {
      query.mockRestore();
    }
  });
});

describe("recordProbeSeen", () => {
  it("keeps one row with the latest seen_at and never moves it back", async () => {
    const first = new Date("2026-10-20T10:00:00.000Z");
    const later = new Date("2026-10-20T10:05:00.000Z");

    await recordProbeSeen(database.pool, first);
    await recordProbeSeen(database.pool, later);
    await recordProbeSeen(database.pool, first);

    const rows = await database.pool.query<{ id: number; seen_at: Date }>("SELECT id, seen_at FROM app.probe_seen");
    expect(rows.rows).toEqual([{ id: 1, seen_at: later }]);
  });
});


import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { getWorkerStatus, recordHeartbeat, upsertWorkerStatus } from "./worker-status.js";
import { createTestDatabase, type TestDatabase } from "./testing/database.js";

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase(inject("testDatabaseAdminUrl"), { from: "template" });
});

afterAll(async () => {
  await database.drop();
});

const T0 = new Date("2026-10-21T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("worker status", () => {
  it("keeps one row: a start overwrites it, a heartbeat moves heartbeat_at forward only", async () => {
    expect(await getWorkerStatus(database.pool)).toBeNull();

    await upsertWorkerStatus(database.pool, { gitSha: "a".repeat(40), startedAt: at(0), smtpConfigured: false, claudeConfigured: true });
    await recordHeartbeat(database.pool, at(10));
    await recordHeartbeat(database.pool, at(5));
    const first = await getWorkerStatus(database.pool);
    await upsertWorkerStatus(database.pool, { gitSha: "b".repeat(40), startedAt: at(100), smtpConfigured: true, claudeConfigured: true });

    expect(first).toEqual({ gitSha: "a".repeat(40), startedAt: at(0), heartbeatAt: at(10), smtpConfigured: false, claudeConfigured: true });
    expect(await getWorkerStatus(database.pool)).toEqual({
      gitSha: "b".repeat(40),
      startedAt: at(100),
      heartbeatAt: at(100),
      smtpConfigured: true,
      claudeConfigured: true,
    });
  });
});

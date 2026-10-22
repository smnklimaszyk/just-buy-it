import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { finishPollRun, overflowPagesSince, recentPollRuns, recentSweepRuns, startPollRun } from "./poll-run.js";
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

const finished = {
  status: "ok" as const,
  finishedAt: at(5),
  pages: 1,
  items: 200,
  malformed: 1,
  newItems: 12,
  candidates: 2,
  capReached: false,
  warningIds: [12001],
  errorKind: null,
  calls: 1,
};

describe("startPollRun and finishPollRun", () => {
  it("commits the running row before the handler goes on, and finishes it once", async () => {
    const id = await startPollRun(database.pool, { kind: "poll", feedId: "gpu", baseline: true, startedAt: T0 });

    // Another session sees the row at once: it is committed, not part of an open transaction.
    const other = new pg.Client({ connectionString: database.url });
    await other.connect();
    try {
      const seen = await other.query("SELECT status, baseline, started_at, finished_at FROM app.poll_run WHERE id = $1", [id]);
      expect(seen.rows).toEqual([{ status: "running", baseline: true, started_at: T0, finished_at: null }]);
    } finally {
      await other.end();
    }

    expect(await finishPollRun(database.pool, id, finished)).toBe(true);
    expect(await finishPollRun(database.pool, id, { ...finished, status: "error", errorKind: "deadline" })).toBe(false);
    const row = await database.pool.query("SELECT * FROM app.poll_run WHERE id = $1", [id]);
    expect(row.rows[0]).toMatchObject({
      status: "ok",
      finished_at: at(5),
      pages: 1,
      items: 200,
      malformed: 1,
      new_items: 12,
      candidates: 2,
      cap_reached: false,
      warning_ids: [12001],
      error_kind: null,
      calls: 1,
    });
  });
});

describe("recentPollRuns, recentSweepRuns and overflowPagesSince", () => {
  it("return the runs of one feed or segment newest first, and count pages beyond page 1 since a time", async () => {
    await database.pool.query("TRUNCATE app.poll_run");
    const poll = async (startedAtS: number, pages: number) => {
      const id = await startPollRun(database.pool, { kind: "poll", feedId: "ram", baseline: false, startedAt: at(startedAtS) });
      await finishPollRun(database.pool, id, { ...finished, finishedAt: at(startedAtS + 2), pages });
    };
    await poll(0, 3);
    await poll(120, 1);
    await poll(240, 2);
    const running = await startPollRun(database.pool, { kind: "poll", feedId: "ram", baseline: false, startedAt: at(360) });
    await startPollRun(database.pool, { kind: "poll", feedId: "gpu", baseline: false, startedAt: at(400) });
    await startPollRun(database.pool, { kind: "sweep", feedId: "ram", segment: "ram_ddr5", startedAt: at(500) });

    const runs = await recentPollRuns(database.pool, "ram", 3);
    const sweeps = await recentSweepRuns(database.pool, "ram_ddr5", 5);

    expect(running).toMatch(/^[0-9a-f-]{36}$/);
    expect(runs).toEqual([
      { status: "running", startedAt: at(360), finishedAt: null },
      { status: "ok", startedAt: at(240), finishedAt: at(242) },
      { status: "ok", startedAt: at(120), finishedAt: at(122) },
    ]);
    expect(sweeps).toEqual([{ status: "running", startedAt: at(500), finishedAt: null }]);
    expect(await overflowPagesSince(database.pool, "ram", at(0))).toBe(3);
    expect(await overflowPagesSince(database.pool, "ram", at(1))).toBe(1);
    expect(await overflowPagesSince(database.pool, "pc", at(0))).toBe(0);
  });
});

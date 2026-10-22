import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import {
  claimScreening,
  finishScreening,
  getScreening,
  pauseScreening,
  releaseScreeningLease,
  screeningPausedUntil,
} from "./screening.js";
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
const key = (n: number) => n.toString(16).padStart(64, "0");
const claimInput = (n: number, now: Date) => ({ itemKey: key(n), promptVersion: "screen-v1:abc", model: "claude-sonnet-5-5", now });

describe("claimScreening", () => {
  it("gives one claim to two concurrent callers, and the other sees a busy claim", async () => {
    const claims = await Promise.all([claimScreening(database.pool, claimInput(1, at(0))), claimScreening(database.pool, claimInput(1, at(0)))]);
    const later = await claimScreening(database.pool, claimInput(1, at(89)));

    expect(claims.map((claim) => claim.kind).sort()).toEqual(["busy", "claimed"]);
    expect(claims.find((claim) => claim.kind === "claimed")).toMatchObject({ attempt: 1 });
    expect(later.kind).toBe("busy");
    const row = await database.pool.query("SELECT status, attempt, lease_until FROM app.screening WHERE item_key = $1", [key(1)]);
    expect(row.rows).toEqual([{ status: "running", attempt: 1, lease_until: at(90) }]);
  });

  it("lets attempt 2 take over a released lease at once, and fails a stale attempt 2 as attempts_exhausted", async () => {
    const first = await claimScreening(database.pool, claimInput(2, at(0)));
    if (first.kind !== "claimed") throw new Error("expected a claim");

    const released = await releaseScreeningLease(database.pool, {
      id: first.id,
      attempt: 1,
      failureCode: "timeout",
      now: at(60),
      usage: { requestBytes: 4000, inputTokens: null, outputTokens: null, costMicrousd: 62000, reservedMicrousd: 62000, latencyMs: 60000, inferenceGeo: null },
    });
    const second = await claimScreening(database.pool, claimInput(2, at(60)));
    const lateRelease = await releaseScreeningLease(database.pool, { id: first.id, attempt: 1, failureCode: "timeout", now: at(61), usage: null });
    const third = await claimScreening(database.pool, claimInput(2, at(60 + 90)));
    const afterwards = await claimScreening(database.pool, claimInput(2, at(200)));

    expect(released).toBe(true);
    expect(second).toEqual({ kind: "claimed", id: first.id, attempt: 2 });
    expect(lateRelease).toBe(false);
    expect(third).toEqual({ kind: "exhausted", id: first.id });
    expect(afterwards).toEqual({ kind: "finished", id: first.id, status: "failed" });
    const row = await database.pool.query("SELECT status, attempt, failure_code, cost_microusd, reserved_microusd FROM app.screening WHERE id = $1", [first.id]);
    expect(row.rows).toEqual([{ status: "failed", attempt: 2, failure_code: "attempts_exhausted", cost_microusd: 62000, reserved_microusd: 62000 }]);
  });
});

describe("finishScreening and getScreening", () => {
  it("writes the result fenced on the attempt, rejects a late result, and keeps the reason in ebay_live until the content expires", async () => {
    const first = await claimScreening(database.pool, claimInput(3, at(0)));
    if (first.kind !== "claimed") throw new Error("expected a claim");
    // Attempt 1 hangs past its lease; attempt 2 takes over.
    await claimScreening(database.pool, claimInput(3, at(91)));
    const usage = { requestBytes: 5000, inputTokens: 2600, outputTokens: 900, costMicrousd: 14200, reservedMicrousd: 62000, latencyMs: 8100, inferenceGeo: "global" };
    const result = {
      status: "done" as const,
      verdict: "caution" as const,
      productMatch: "match" as const,
      riskFlags: ["mining_history"],
      codeSignals: ["payment_mention" as const],
      failureCode: null,
      reason: "Used for mining; ask about the fans.",
      reasonExpiresAt: at(6 * 3600),
      usage,
    };

    const late = await finishScreening(database.pool, { id: first.id, attempt: 1, now: at(100), ...result, verdict: "pass" as const });
    const written = await finishScreening(database.pool, { id: first.id, attempt: 2, now: at(101), ...result });
    const again = await finishScreening(database.pool, { id: first.id, attempt: 2, now: at(102), ...result });

    expect([late, written, again]).toEqual([false, true, false]);
    expect(await getScreening(database.pool, first.id)).toEqual({
      id: first.id,
      itemKey: key(3),
      promptVersion: "screen-v1:abc",
      model: "claude-sonnet-5-5",
      status: "done",
      attempt: 2,
      verdict: "caution",
      productMatch: "match",
      riskFlags: ["mining_history"],
      codeSignals: ["payment_mention"],
      failureCode: null,
      reason: "Used for mining; ask about the fans.",
      ...usage,
    });
    const text = await database.pool.query("SELECT reason, expires_at FROM ebay_live.screening_text WHERE screening_id = $1", [first.id]);
    expect(text.rows).toEqual([{ reason: "Used for mining; ask about the fans.", expires_at: at(6 * 3600) }]);
  });
});

describe("pauseScreening and screeningPausedUntil", () => {
  it("pauses screening after auth_failed until the given time, and a shorter pause never cuts it", async () => {
    expect(await screeningPausedUntil(database.pool, at(0))).toBeNull();

    await pauseScreening(database.pool, at(900));
    await pauseScreening(database.pool, at(600));

    expect(await screeningPausedUntil(database.pool, at(899))).toEqual(at(900));
    expect(await screeningPausedUntil(database.pool, at(900))).toBeNull();
  });
});

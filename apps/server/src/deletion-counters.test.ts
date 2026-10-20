import { describe, expect, it, vi } from "vitest";
import { createDeletionCounters, type HourlyCounts } from "./deletion-counters.js";

const at = (iso: string) => new Date(iso).getTime();

function harness(store: (counts: HourlyCounts) => Promise<void> = async () => undefined) {
  const now = { value: at("2026-10-20T10:15:00Z") };
  const stored: HourlyCounts[] = [];
  const infos: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  const counters = createDeletionCounters({
    clock: { now: () => new Date(now.value) },
    store: async (counts) => {
      stored.push(counts);
      await store(counts);
    },
    log: { info: (entry) => infos.push(entry), warn: (entry) => warnings.push(entry) },
  });
  return { counters, now, stored, infos, warnings };
}

describe("createDeletionCounters", () => {
  it("adds results and eBay requests up per UTC hour and sends them in one store call", async () => {
    const run = harness();

    run.counters.countResult("malformed");
    run.counters.countResult("malformed");
    run.counters.countRequest("commerce.notification", "deletion-key");
    run.now.value = at("2026-10-20T11:00:00Z");
    run.counters.countResult("malformed");
    await run.counters.flush();
    await run.counters.flush();

    expect(run.stored).toEqual([
      {
        deletionResults: [
          { hourUtc: new Date("2026-10-20T10:00:00Z"), result: "malformed", count: 2 },
          { hourUtc: new Date("2026-10-20T11:00:00Z"), result: "malformed", count: 1 },
        ],
        apiUsage: [
          { hourUtc: new Date("2026-10-20T10:00:00Z"), resource: "commerce.notification", purpose: "deletion-key", calls: 1 },
        ],
      },
    ]);
  });

  it("puts a failed snapshot back next to the counts that arrived meanwhile, and saves each count once later", async () => {
    let fail = true;
    let release: () => void = () => undefined;
    const run = harness(
      () =>
        new Promise<void>((resolve, reject) => {
          release = () => (fail ? reject(Object.assign(new Error("down"), { code: "57P03" })) : resolve());
        }),
    );

    run.counters.countResult("dropped");
    const first = run.counters.flush();
    run.counters.countResult("dropped");
    run.counters.countRequest("identity.oauth2", "token");
    await Promise.resolve();
    release();
    await first;

    fail = false;
    const second = run.counters.flush();
    await Promise.resolve();
    release();
    await second;

    expect(run.stored.at(-1)).toEqual({
      deletionResults: [{ hourUtc: new Date("2026-10-20T10:00:00Z"), result: "dropped", count: 2 }],
      apiUsage: [{ hourUtc: new Date("2026-10-20T10:00:00Z"), resource: "identity.oauth2", purpose: "token", calls: 1 }],
    });
    expect(run.counters.unsaved()).toEqual({ deletionResults: [], apiUsage: [] });
  });

  it("logs the unsaved counts on the first failure, then at most every 10 minutes, and once on recovery", async () => {
    let down = true;
    const run = harness(async () => {
      if (down) throw new Error("connect ECONNREFUSED");
    });

    for (const minutes of [0, 1, 9, 10, 11]) {
      run.now.value = at("2026-10-20T10:15:00Z") + minutes * 60_000;
      run.counters.countResult("malformed");
      await run.counters.flush();
    }
    expect(run.warnings.map((line) => line.event)).toEqual(["deletion_counts_unsaved", "deletion_counts_unsaved"]);
    expect(run.warnings[0]).toEqual({
      event: "deletion_counts_unsaved",
      counts: { deletionResults: [{ hourUtc: new Date("2026-10-20T10:00:00Z"), result: "malformed", count: 1 }], apiUsage: [] },
    });

    down = false;
    await run.counters.flush();
    run.counters.countResult("malformed");
    await run.counters.flush();
    expect(run.infos).toEqual([{ event: "deletion_counts_saved" }]);
    expect(run.stored.at(-2)?.deletionResults).toEqual([
      { hourUtc: new Date("2026-10-20T10:00:00Z"), result: "malformed", count: 5 },
    ]);
  });

  it("starts no second flush while one is in flight, reports both as unsaved, and flushAll saves the rest", async () => {
    const releases: (() => void)[] = [];
    const run = harness(() => new Promise<void>((resolve) => releases.push(resolve)));
    const settle = async () => {
      while (releases.length === 0) await Promise.resolve();
      releases.shift()?.();
    };

    run.counters.countResult("bad_signature");
    const first = run.counters.flush();
    run.counters.countResult("key_rejected");
    await run.counters.flush();
    expect(run.stored).toHaveLength(1);
    expect(run.counters.unsaved().deletionResults.map((row) => row.result).sort()).toEqual(["bad_signature", "key_rejected"]);

    const all = run.counters.flushAll();
    await settle();
    await first;
    await settle();

    expect(await all).toBe(true);
    expect(run.stored.map((counts) => counts.deletionResults.map((row) => row.result))).toEqual([
      ["bad_signature"],
      ["key_rejected"],
    ]);
    expect(run.counters.unsaved()).toEqual({ deletionResults: [], apiUsage: [] });
  });

  it("writes one flood line per UTC hour at the 1,001st non-verified result, even with the store down", async () => {
    const run = harness(async () => {
      throw new Error("down");
    });
    const floodLines = () => run.warnings.filter((line) => line.event === "deletion_results_flood");

    run.now.value = at("2026-10-20T10:00:00.000Z");
    for (let i = 0; i < 999; i += 1) run.counters.countResult("key_rejected");
    run.now.value = at("2026-10-20T10:59:59.999Z");
    run.counters.countResult("dropped");
    await run.counters.flush();
    expect(floodLines()).toEqual([]);

    run.counters.countResult("dropped_on_shutdown");
    expect(floodLines()).toEqual([{ event: "deletion_results_flood", hour_utc: "2026-10-20T10:00:00.000Z", threshold: 1000 }]);
    for (let i = 0; i < 999; i += 1) run.counters.countResult("malformed");
    expect(floodLines()).toHaveLength(1);

    run.now.value = at("2026-10-20T11:00:00.000Z");
    for (let i = 0; i < 1_000; i += 1) run.counters.countResult("malformed");
    expect(floodLines()).toHaveLength(1);
    run.counters.countResult("malformed");
    expect(floodLines()).toEqual([
      { event: "deletion_results_flood", hour_utc: "2026-10-20T10:00:00.000Z", threshold: 1000 },
      { event: "deletion_results_flood", hour_utc: "2026-10-20T11:00:00.000Z", threshold: 1000 },
    ]);
  });

  it("answers false from flushAll when the store fails, and keeps the counts as unsaved", async () => {
    const run = harness(async () => {
      throw new Error("down");
    });
    run.counters.countRequest("commerce.notification", "deletion-key");

    expect(await run.counters.flushAll()).toBe(false);
    expect(run.counters.unsaved().apiUsage).toEqual([
      { hourUtc: new Date("2026-10-20T10:00:00Z"), resource: "commerce.notification", purpose: "deletion-key", calls: 1 },
    ]);
    expect(await harness().counters.flushAll()).toBe(true);
  });

  it("flushes every 10 s once started, with a timer that does not keep the process alive", async () => {
    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      const run = harness();
      run.counters.start();
      run.counters.countResult("malformed");

      await vi.advanceTimersByTimeAsync(9_999);
      expect(run.stored).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.stored).toHaveLength(1);
      expect(setIntervalSpy.mock.results[0]?.value.hasRef()).toBe(false);

      run.counters.stop();
      run.counters.countResult("malformed");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(run.stored).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

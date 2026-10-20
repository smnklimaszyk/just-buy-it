import { describe, expect, it } from "vitest";
import { createProbeRecorder } from "./probe.js";

describe("createProbeRecorder", () => {
  it("writes at most once a minute with the time from the clock", () => {
    const now = { value: new Date("2026-10-20T10:00:00Z").getTime() };
    const writes: Date[] = [];
    const { seen } = createProbeRecorder({
      clock: { now: () => new Date(now.value) },
      record: async (seenAt) => {
        writes.push(seenAt);
      },
      log: { warn: () => undefined },
    });

    for (let i = 0; i < 100; i += 1) {
      seen();
      now.value += 590;
    }
    expect(writes).toEqual([new Date("2026-10-20T10:00:00Z")]);

    now.value = new Date("2026-10-20T10:01:00Z").getTime();
    seen();
    expect(writes).toEqual([new Date("2026-10-20T10:00:00Z"), new Date("2026-10-20T10:01:00Z")]);
  });

  it("logs a failed write at most every 10 minutes, without the probe code, and never throws", async () => {
    const now = { value: new Date("2026-10-20T10:00:00Z").getTime() };
    const warnings: Record<string, unknown>[] = [];
    let attempts = 0;
    const { seen } = createProbeRecorder({
      clock: { now: () => new Date(now.value) },
      record: async () => {
        attempts += 1;
        throw new Error("connect ECONNREFUSED; probe code abc");
      },
      log: { warn: (entry) => warnings.push(entry) },
    });

    for (let minute = 0; minute <= 10; minute += 1) {
      now.value = new Date("2026-10-20T10:00:00Z").getTime() + minute * 60_000;
      expect(() => seen()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(attempts).toBe(11);
    expect(warnings).toEqual([{ event: "probe_seen_unsaved" }, { event: "probe_seen_unsaved" }]);
  });
});

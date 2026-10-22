import { describe, expect, it } from "vitest";
import { startingFeed, startingSegmentRule } from "./rules.js";
import { effectiveRunStatus, pollDue, pollIntervalSeconds, sweepDue, type RunRow, type RunStatus } from "./schedule.js";

const gpu = startingFeed("gpu");

describe("pollIntervalSeconds", () => {
  it.each([
    ["06:59 CEST", "2026-10-21T04:59:00Z", 600],
    ["07:00 CEST", "2026-10-21T05:00:00Z", 120],
    ["22:59 CEST", "2026-10-21T20:59:00Z", 120],
    ["23:00 CEST", "2026-10-21T21:00:00Z", 600],
    ["06:59 CET after the switch on 2026-10-25", "2026-10-25T05:59:00Z", 600],
    ["07:00 CET after the switch on 2026-10-25", "2026-10-25T06:00:00Z", 120],
    ["03:00 CET on 2026-10-25", "2026-10-25T02:00:00Z", 600],
  ])("at %s is %i s", (_name, iso, seconds) => {
    expect(pollIntervalSeconds(gpu, new Date(iso))).toBe(seconds);
  });
});

describe("effectiveRunStatus", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const run = (status: RunStatus, secondsAgo: number) => ({
    status,
    startedAt: new Date(now.getTime() - secondsAgo * 1000),
    finishedAt: status === "running" ? null : now,
  });

  it.each([
    ["a fresh running row", run("running", 60), "running"],
    ["a running row exactly 5 min old", run("running", 300), "running"],
    ["a running row 5 min + 1 s old (stale)", run("running", 301), "error"],
    ["a finished row", run("ok", 3600), "ok"],
    ["an old error row", run("error", 3600), "error"],
  ] as const)("reads %s as %s", (_name, r, status) => {
    expect(effectiveRunStatus(r, now)).toBe(status);
  });
});

describe("pollDue", () => {
  const day = new Date("2026-10-21T12:00:00Z");
  const night = new Date("2026-10-21T23:00:00Z");
  const enabled = { ...gpu, enabled: true };
  const ago = (now: Date, s: number) => new Date(now.getTime() - s * 1000);
  const ok = (now: Date, s: number): RunRow => ({ status: "ok", startedAt: ago(now, s), finishedAt: ago(now, s - 5) });
  const err = (now: Date, s: number): RunRow => ({ status: "error", startedAt: ago(now, s), finishedAt: ago(now, s - 5) });
  const running = (now: Date, s: number): RunRow => ({ status: "running", startedAt: ago(now, s), finishedAt: null });
  const errors = (now: Date, newestS: number, count: number) =>
    Array.from({ length: count }, (_, i) => err(now, newestS + i * 120));

  it.each([
    ["no run yet", enabled, [], day, { due: true }],
    ["a paused feed", gpu, [], day, { due: false, reason: "paused" }],
    ["a fresh running row", enabled, [running(day, 30)], day, { due: false, reason: "running" }],
    ["a running row 5 min + 1 s old", enabled, [running(day, 301)], day, { due: true }],
    ["the last poll started interval - 20 s ago", enabled, [ok(day, 100)], day, { due: true }],
    ["the last poll started 99 s ago", enabled, [ok(day, 99)], day, { due: false, reason: "interval" }],
    ["at night, 579 s ago", enabled, [ok(night, 579)], night, { due: false, reason: "interval" }],
    ["at night, 580 s ago", enabled, [ok(night, 580)], night, { due: true }],
    ["5 errors, the newest 10 min ago", enabled, errors(day, 600, 5), day, { due: false, reason: "breaker" }],
    ["5 errors, the newest 15 min ago", enabled, errors(day, 905, 5), day, { due: true }],
    ["4 errors and an ok", enabled, [...errors(day, 600, 4), ok(day, 1200)], day, { due: true }],
    ["4 errors under a stale running row", enabled, [running(day, 360), ...errors(day, 480, 4)], day, { due: false, reason: "breaker" }],
    ["5 quota refusals", enabled, Array.from({ length: 5 }, (_, i) => ({ ...ok(day, 120 + i * 120), status: "quota_refused" as const })), day, { due: true }],
  ] as const)("%s", (_name, feed, runs, now, expected) => {
    expect(pollDue(feed, runs, now)).toEqual(expected);
  });
});

describe("sweepDue", () => {
  const feed = { ...gpu, enabled: true };
  const rule = startingSegmentRule("gpu_4090");
  const at = (iso: string) => new Date(iso);
  const run = (status: RunStatus, iso: string): RunRow => ({ status, startedAt: at(iso), finishedAt: status === "running" ? null : at(iso) });

  it.each([
    ["in its slot :25 with no sweep yet", feed, rule, true, [], "2026-10-21T12:25:00Z", { due: true }],
    ["in its slot at :25:59", feed, rule, true, [], "2026-10-21T12:25:59Z", { due: true }],
    ["outside its slot at :24", feed, rule, true, [], "2026-10-21T12:24:00Z", { due: false, reason: "slot" }],
    ["outside its slot at :26", feed, rule, true, [], "2026-10-21T12:26:00Z", { due: false, reason: "slot" }],
    ["before the feed's baseline poll finished", feed, rule, false, [], "2026-10-21T12:25:00Z", { due: false, reason: "baseline" }],
    ["with the feed paused", gpu, rule, true, [], "2026-10-21T12:25:00Z", { due: false, reason: "paused" }],
    ["with the segment disabled", feed, { ...rule, enabled: false }, true, [], "2026-10-21T12:25:00Z", { due: false, reason: "paused" }],
    ["55 min after the last sweep", feed, rule, true, [run("ok", "2026-10-21T11:30:00Z")], "2026-10-21T12:25:00Z", { due: true }],
    ["54 min after the last sweep", feed, rule, true, [run("ok", "2026-10-21T11:31:00Z")], "2026-10-21T12:25:00Z", { due: false, reason: "interval" }],
    ["with a fresh running sweep", feed, rule, true, [run("running", "2026-10-21T12:25:00Z")], "2026-10-21T12:25:30Z", { due: false, reason: "running" }],
    ["a slot in winter time", feed, rule, true, [run("ok", "2026-12-01T11:25:00Z")], "2026-12-01T12:25:00Z", { due: true }],
  ] as const)("%s", (_name, f, r, baselineDone, runs, now, expected) => {
    expect(sweepDue(f, r, baselineDone, runs, at(now))).toEqual(expected);
  });
});

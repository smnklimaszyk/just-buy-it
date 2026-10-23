import { describe, expect, it } from "vitest";
import { effectiveRunStatus, type RunStatus } from "./schedule.js";

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

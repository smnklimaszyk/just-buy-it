import { describe, expect, it } from "vitest";
import { checkEmailRate } from "./rate.js";

const now = new Date("2026-10-21T12:00:00Z"); // 14:00 CEST
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);
const sendsMinutesAgo = (...m: number[]) => m.map(minutesAgo);
// n sends between 02:00 and 11:00 CEST today, all outside the last hour.
const earlierToday = (n: number) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 9, 21, 0, 0) + i * 9 * 60_000));

describe("checkEmailRate", () => {
  it.each([
    ["9 in the last hour", sendsMinutesAgo(50, 45, 40, 35, 30, 25, 20, 15, 10), { ok: true }],
    ["10 in the last hour", sendsMinutesAgo(50, 45, 40, 35, 30, 25, 20, 15, 10, 5), { ok: false, nextAttemptAt: minutesAgo(-10), limit: "hour" }],
    ["10, the oldest exactly an hour ago", sendsMinutesAgo(60, 45, 40, 35, 30, 25, 20, 15, 10, 5), { ok: true }],
    ["12 in the last hour", sendsMinutesAgo(55, 52, 50, 45, 40, 35, 30, 25, 20, 15, 10, 5), { ok: false, nextAttemptAt: minutesAgo(-10), limit: "hour" }],
    ["59 today", earlierToday(59), { ok: true }],
    ["60 today", earlierToday(60), { ok: false, nextAttemptAt: new Date("2026-10-21T22:00:00Z"), limit: "day" }],
    ["59 today and more yesterday", [...earlierToday(59), new Date("2026-10-20T21:59:00Z")], { ok: true }],
    ["60 today, 10 of them in the last hour", [...earlierToday(50), ...sendsMinutesAgo(50, 45, 40, 35, 30, 25, 20, 15, 10, 5)], { ok: false, nextAttemptAt: new Date("2026-10-21T22:00:00Z"), limit: "day" }],
  ])("%s", (_name, sends, expected) => {
    expect(checkEmailRate(sends, now)).toEqual(expected);
  });
});

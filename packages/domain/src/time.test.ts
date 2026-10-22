import { describe, expect, it } from "vitest";
import {
  berlinDay,
  berlinWallTime,
  berlinZoneName,
  formatAsOf,
  formatBerlinTime,
  startOfBerlinDay,
  startOfNextBerlinDay,
} from "./time.js";

describe("Berlin wall time", () => {
  it("reads summer time as UTC+2", () => {
    const t = berlinWallTime(new Date("2026-10-21T12:32:10Z"));
    expect(t).toEqual({ year: 2026, month: 10, day: 21, hour: 14, minute: 32, second: 10, offsetMinutes: 120 });
  });
});

describe("berlinZoneName", () => {
  it.each([
    ["2026-10-25T00:59:59Z", "CEST"],
    ["2026-10-25T01:00:00Z", "CET"],
    ["2026-03-29T00:59:59Z", "CET"],
    ["2026-03-29T01:00:00Z", "CEST"],
  ])("names the zone at %s as %s", (iso, zone) => {
    expect(berlinZoneName(new Date(iso))).toBe(zone);
  });
});

describe("berlinDay", () => {
  it.each([
    ["2026-10-21T21:59:59Z", "2026-10-21"],
    ["2026-10-21T22:00:00Z", "2026-10-22"],
    ["2026-12-31T22:59:59Z", "2026-12-31"],
    ["2026-12-31T23:00:00Z", "2027-01-01"],
  ])("gives the Berlin calendar date of %s as %s", (iso, day) => {
    expect(berlinDay(new Date(iso))).toBe(day);
  });
});

describe("Berlin day bounds", () => {
  it.each([
    ["summer time", "2026-10-21T12:00:00Z", "2026-10-20T22:00:00.000Z", "2026-10-21T22:00:00.000Z"],
    ["winter time", "2026-12-02T08:00:00Z", "2026-12-01T23:00:00.000Z", "2026-12-02T23:00:00.000Z"],
    ["the 25-hour day", "2026-10-25T20:00:00Z", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    ["the 23-hour day", "2026-03-29T12:00:00Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["the first instant of a day", "2026-10-20T22:00:00Z", "2026-10-20T22:00:00.000Z", "2026-10-21T22:00:00.000Z"],
  ])("gives the start and the next start in %s", (_name, now, start, next) => {
    expect(startOfBerlinDay(new Date(now)).toISOString()).toBe(start);
    expect(startOfNextBerlinDay(new Date(now)).toISOString()).toBe(next);
  });
});

describe("formatting", () => {
  it.each([
    ["2026-10-21T12:32:00Z", "14:32 CEST", "As of 14:32 CEST, 21 Oct 2026"],
    ["2026-11-02T07:05:00Z", "08:05 CET", "As of 08:05 CET, 2 Nov 2026"],
    ["2026-01-04T23:10:00Z", "00:10 CET", "As of 00:10 CET, 5 Jan 2026"],
  ])("formats %s as %s and as the email line", (iso, time, asOf) => {
    expect(formatBerlinTime(new Date(iso))).toBe(time);
    expect(formatAsOf(new Date(iso))).toBe(asOf);
  });
});

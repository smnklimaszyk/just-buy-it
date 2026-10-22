import { startOfBerlinDay, startOfNextBerlinDay } from "../time.js";

// Section 6.4, counted over deliveries in `sending` or `sent`.
export const EMAILS_PER_HOUR = 10;
export const EMAILS_PER_BERLIN_DAY = 60;
const HOUR_MS = 60 * 60 * 1000;

export type EmailRateDecision = { ok: true } | { ok: false; nextAttemptAt: Date; limit: "hour" | "day" };

// sendTimes: the send times of the counted deliveries since at least the start of the Berlin day
// and the last hour. Over a limit, the delivery waits until enough counted sends leave the window.
export function checkEmailRate(sendTimes: readonly Date[], now: Date): EmailRateDecision {
  const t = now.getTime();
  const lastHour = sendTimes
    .map((d) => d.getTime())
    .filter((s) => s > t - HOUR_MS && s <= t)
    .sort((a, b) => a - b);
  const dayStart = startOfBerlinDay(now).getTime();
  const today = sendTimes.filter((d) => d.getTime() >= dayStart && d.getTime() <= t).length;

  if (today >= EMAILS_PER_BERLIN_DAY) return { ok: false, nextAttemptAt: startOfNextBerlinDay(now), limit: "day" };
  if (lastHour.length >= EMAILS_PER_HOUR) {
    const leaving = lastHour[lastHour.length - EMAILS_PER_HOUR] ?? t;
    return { ok: false, nextAttemptAt: new Date(leaving + HOUR_MS), limit: "hour" };
  }
  return { ok: true };
}

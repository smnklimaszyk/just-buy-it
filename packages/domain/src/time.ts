// ADR 0008: code reads the time only through an injected clock.
export type Clock = { now(): Date };

export type BerlinWallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
};

const berlinParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function berlinWallTime(at: Date): BerlinWallTime {
  const parts: Record<string, number> = {};
  for (const part of berlinParts.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const t = {
    year: parts["year"] ?? 0,
    month: parts["month"] ?? 0,
    day: parts["day"] ?? 0,
    hour: parts["hour"] ?? 0,
    minute: parts["minute"] ?? 0,
    second: parts["second"] ?? 0,
  };
  const wallAsUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
  return { ...t, offsetMinutes };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// The Berlin calendar date as YYYY-MM-DD, the key of every per-day count and cap.
export function berlinDay(at: Date): string {
  const t = berlinWallTime(at);
  return `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;
}

// Berlin midnight of a calendar date. Midnight never falls into a clock switch (those are at
// 02:00 and 03:00), so the offset read at the first guess is right after one correction.
function berlinMidnight(year: number, month: number, day: number): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  let guess = wallAsUtc - berlinWallTime(new Date(wallAsUtc)).offsetMinutes * 60_000;
  guess = wallAsUtc - berlinWallTime(new Date(guess)).offsetMinutes * 60_000;
  return new Date(guess);
}

export function startOfBerlinDay(at: Date): Date {
  const t = berlinWallTime(at);
  return berlinMidnight(t.year, t.month, t.day);
}

export function startOfNextBerlinDay(at: Date): Date {
  const t = berlinWallTime(at);
  return berlinMidnight(t.year, t.month, t.day + 1);
}

export function berlinZoneName(at: Date): "CEST" | "CET" {
  return berlinWallTime(at).offsetMinutes === 120 ? "CEST" : "CET";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "14:32 CEST"
export function formatBerlinTime(at: Date): string {
  const t = berlinWallTime(at);
  return `${pad2(t.hour)}:${pad2(t.minute)} ${berlinZoneName(at)}`;
}

// "As of 14:32 CEST, 21 Oct 2026"
export function formatAsOf(at: Date): string {
  const t = berlinWallTime(at);
  return `As of ${formatBerlinTime(at)}, ${t.day} ${MONTHS[t.month - 1]} ${t.year}`;
}

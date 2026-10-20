import type { ClockLike } from "@ebay-sniper/ebay";
import type { DeletionResult, LogFn } from "./notifications.js";

// The shape of addHourlyCounts in @ebay-sniper/db: one statement for both tables.
export type HourlyCounts = {
  deletionResults: { hourUtc: Date; result: string; count: number }[];
  apiUsage: { hourUtc: Date; resource: string; purpose: string; calls: number }[];
};

export type DeletionCountersOptions = {
  clock: ClockLike;
  store: (counts: HourlyCounts) => Promise<void>;
  log: { info: LogFn; warn: LogFn };
};

export const FLUSH_INTERVAL_MS = 10_000;
const UNSAVED_LOG_EVERY_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
// ADR 0013: more than 1,000 non-verified results in an hour. Phase 1 ops-alerts mails on it.
const FLOOD_THRESHOLD = 1_000;

type Snapshot = {
  results: Map<string, { hour: number; result: string; count: number }>;
  usage: Map<string, { hour: number; resource: string; purpose: string; calls: number }>;
};

const emptySnapshot = (): Snapshot => ({ results: new Map(), usage: new Map() });

// Counts are added up in memory and written every 10 s, never awaited by the queue, so a down
// database never delays a notification (spec S3, section 2.4).
export function createDeletionCounters(options: DeletionCountersOptions) {
  const { clock, log } = options;
  let current = emptySnapshot();
  let inFlight: { snapshot: Snapshot; done: Promise<void> } | undefined;
  let failing = false;
  let lastUnsavedLogAt = 0;
  let floodHour = -1;
  let floodCount = 0;
  let timer: NodeJS.Timeout | undefined;

  const currentHour = () => Math.floor(clock.now().getTime() / HOUR_MS);

  function addResult(into: Snapshot, hour: number, result: string, count: number): void {
    const key = `${hour}|${result}`;
    const entry = into.results.get(key);
    if (entry) entry.count += count;
    else into.results.set(key, { hour, result, count });
  }

  function addUsage(into: Snapshot, hour: number, resource: string, purpose: string, calls: number): void {
    const key = `${hour}|${resource}|${purpose}`;
    const entry = into.usage.get(key);
    if (entry) entry.calls += calls;
    else into.usage.set(key, { hour, resource, purpose, calls });
  }

  function merge(into: Snapshot, from: Snapshot): void {
    for (const { hour, result, count } of from.results.values()) addResult(into, hour, result, count);
    for (const { hour, resource, purpose, calls } of from.usage.values()) addUsage(into, hour, resource, purpose, calls);
  }

  function toCounts(snapshot: Snapshot): HourlyCounts {
    return {
      deletionResults: [...snapshot.results.values()].map(({ hour, result, count }) => ({
        hourUtc: new Date(hour * HOUR_MS),
        result,
        count,
      })),
      apiUsage: [...snapshot.usage.values()].map(({ hour, resource, purpose, calls }) => ({
        hourUtc: new Date(hour * HOUR_MS),
        resource,
        purpose,
        calls,
      })),
    };
  }

  const isEmpty = (snapshot: Snapshot) => snapshot.results.size === 0 && snapshot.usage.size === 0;

  // Every result except verified. The flood line is written once per UTC hour, at the 1,001st.
  function countResult(result: DeletionResult): void {
    const hour = currentHour();
    addResult(current, hour, result, 1);
    if (hour !== floodHour) {
      floodHour = hour;
      floodCount = 0;
    }
    floodCount += 1;
    if (floodCount === FLOOD_THRESHOLD + 1) {
      log.warn({
        event: "deletion_results_flood",
        hour_utc: new Date(hour * HOUR_MS).toISOString(),
        threshold: FLOOD_THRESHOLD,
      });
    }
  }

  function countRequest(resource: string, purpose: string): void {
    addUsage(current, currentHour(), resource, purpose, 1);
  }

  // Every count not confirmed saved: the in-memory counts and a flush still in flight.
  function unsaved(): HourlyCounts {
    const all = emptySnapshot();
    merge(all, current);
    if (inFlight) merge(all, inFlight.snapshot);
    return toCounts(all);
  }

  function saved(): void {
    if (!failing) return;
    failing = false;
    log.info({ event: "deletion_counts_saved" });
  }

  // Only this snapshot goes back; counts that arrived during the flush are already in current.
  function failed(snapshot: Snapshot): void {
    merge(current, snapshot);
    const now = clock.now().getTime();
    if (failing && now - lastUnsavedLogAt < UNSAVED_LOG_EVERY_MS) return;
    failing = true;
    lastUnsavedLogAt = now;
    log.warn({ event: "deletion_counts_unsaved", counts: toCounts(current) });
  }

  // One flush at a time: a call that finds one in flight does nothing. Never rejects.
  async function flush(): Promise<void> {
    if (inFlight || isEmpty(current)) return;
    const snapshot = current;
    current = emptySnapshot();
    const done = Promise.resolve()
      .then(() => options.store(toCounts(snapshot)))
      .then(saved, () => failed(snapshot))
      .finally(() => {
        inFlight = undefined;
      });
    inFlight = { snapshot, done };
    await done;
  }

  // For shutdown: wait for a flush in flight, then flush the rest. True when nothing is left unsaved.
  async function flushAll(): Promise<boolean> {
    while (inFlight) await inFlight.done;
    await flush();
    return isEmpty(current) && !inFlight;
  }

  function start(): void {
    timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
    timer.unref();
  }

  function stop(): void {
    clearInterval(timer);
  }

  return { countResult, countRequest, flush, flushAll, unsaved, start, stop };
}

export type DeletionCounters = ReturnType<typeof createDeletionCounters>;

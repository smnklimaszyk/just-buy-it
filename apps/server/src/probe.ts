import type { ClockLike } from "@ebay-sniper/ebay";
import type { LogFn } from "./notifications.js";

const WRITE_EVERY_MS = 60_000;
const FAILURE_LOG_EVERY_MS = 10 * 60_000;

// Records that the external probe reached us (app.probe_seen, ADR 0030). At most one write a
// minute, and the time of the attempt is taken before the write, so a down database is not hit on
// every probe. The write is never awaited; no line ever holds the probe code.
export function createProbeRecorder(options: {
  clock: ClockLike;
  record: (seenAt: Date) => Promise<void>;
  log: { warn: LogFn };
}) {
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let lastFailureLogAt = Number.NEGATIVE_INFINITY;

  function seen(): void {
    const seenAt = options.clock.now();
    if (seenAt.getTime() - lastAttemptAt < WRITE_EVERY_MS) return;
    lastAttemptAt = seenAt.getTime();
    void options.record(seenAt).catch(() => {
      const now = options.clock.now().getTime();
      if (now - lastFailureLogAt < FAILURE_LOG_EVERY_MS) return;
      lastFailureLogAt = now;
      options.log.warn({ event: "probe_seen_unsaved" });
    });
  }

  return { seen };
}

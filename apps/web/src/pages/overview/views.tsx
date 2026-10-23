import type { SearchStatus, WorkerStatus } from "@ebay-sniper/db";
import { formatBerlinTime, formatUsd } from "@ebay-sniper/domain";
import { Banner, StatusDot, type Tone } from "../../ui/feedback.js";
import { formatWhen } from "../products/format.js";

// Spec 8.3 /: the live state of the worker and the searches, as a StatusDot and a word each.

// The worker writes a heartbeat every 10 s; a minute without one means it is not running.
const WORKER_SILENT_AFTER_MS = 60_000;

type Shown = { tone: Tone; label: string };

function workerState(worker: WorkerStatus | null, now: Date): Shown {
  if (worker === null) return { tone: "neutral", label: "Worker has not started yet" };
  if (now.getTime() - worker.heartbeatAt.getTime() <= WORKER_SILENT_AFTER_MS) return { tone: "success", label: "Worker running" };
  return { tone: "danger", label: `Worker not reporting, last heartbeat ${formatWhen(worker.heartbeatAt, now)}` };
}

function searchState(search: SearchStatus, now: Date): Shown {
  if (!search.enabled) return { tone: "neutral", label: "paused" };
  const poll = search.lastPoll;
  if (poll === null) return { tone: "neutral", label: "not polled yet" };
  const when = formatWhen(poll.startedAt, now);
  if (poll.status === "ok") return { tone: "success", label: `last poll ${when}` };
  if (poll.status === "running") return { tone: "info", label: `polling, started ${when}` };
  if (poll.status === "quota_refused") return { tone: "warning", label: `last poll refused by the eBay budget ${when}` };
  if (poll.status === "paused") return { tone: "warning", label: `polls paused after repeated errors, last ${when}` };
  return { tone: "danger", label: `last poll failed ${when}` };
}

const UNTIL_MIDNIGHT = 'Until midnight alerts say "Not checked by Claude", and products that require the check hold them.';

export type BannerInput = {
  // From the settings read: a stored value that is not valid or above its .env ceiling (spec 2.5).
  warnings: string[];
  screeningPausedUntil: Date | null;
  smtpPausedUntil: Date | null;
  claude: { calls: number; spentMicrousd: number };
  callLimit: number;
  spendLimitMicrousd: number;
};

// Spec 8.2: Banners for platform state.
export function PlatformBanners({ input }: { input: BannerInput }) {
  const callsUsed = input.callLimit > 0 && input.claude.calls >= input.callLimit;
  const spendUsed = input.spendLimitMicrousd > 0 && input.claude.spentMicrousd >= input.spendLimitMicrousd;
  return (
    <>
      {input.warnings.map((warning) => (
        <Banner tone="warning">{warning}</Banner>
      ))}
      {input.screeningPausedUntil !== null && <Banner tone="warning">{`Claude checks are paused until ${formatBerlinTime(input.screeningPausedUntil)}.`}</Banner>}
      {input.smtpPausedUntil !== null && (
        <Banner tone="warning">{`Alert emails are paused until ${formatBerlinTime(input.smtpPausedUntil)}. They go out when the pause ends.`}</Banner>
      )}
      {callsUsed && <Banner tone="info">{`Today's ${String(input.callLimit)} Claude checks are used up. ${UNTIL_MIDNIGHT}`}</Banner>}
      {!callsUsed && spendUsed && (
        <Banner tone="info">{`Today's Claude spend cap of ${formatUsd(input.spendLimitMicrousd)} is used up. ${UNTIL_MIDNIGHT}`}</Banner>
      )}
    </>
  );
}

export function PlatformState({ worker, searches, now }: { worker: WorkerStatus | null; searches: SearchStatus[]; now: Date }) {
  const shown = workerState(worker, now);
  return (
    <div class="app-stack">
      <div>
        <StatusDot tone={shown.tone} label={shown.label} />
      </div>
      {searches.map((search) => {
        const state = searchState(search, now);
        const products = search.products.length === 0 ? "no products" : search.products.join(", ");
        return (
          <div>
            <StatusDot tone={state.tone} label={`${search.id} (${products}): ${state.label}`} />
          </div>
        );
      })}
    </div>
  );
}

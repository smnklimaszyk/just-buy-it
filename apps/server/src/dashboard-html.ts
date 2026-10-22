import type {
  AlertRow,
  BlockedRow,
  CandidatesPage,
  Overview,
  PricesRow,
  PriceWindow,
  RejectionsPage,
  RunSummary,
  ScreeningRow,
} from "@ebay-sniper/db";
import {
  MIN_SAMPLES_FOR_SUGGESTION,
  berlinWallTime,
  formatAsOf,
  formatBerlinTime,
  formatEur,
  segmentLabel,
} from "@ebay-sniper/domain";

// Section 8.1: server-rendered pages with every value escaped, refreshed every minute, no script.

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `body{font:14px/1.4 system-ui,sans-serif;margin:16px;color:#1a1a1a;background:#fff}
nav a{margin-right:12px}h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;margin:8px 0}th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f2f2f2}.muted{color:#666}`;

const NAV: readonly [string, string][] = [
  ["/", "Overview"],
  ["/candidates", "Candidates"],
  ["/alerts", "Alerts"],
  ["/blocked", "Blocked"],
  ["/screenings", "Screenings"],
  ["/rejections", "Rejections"],
  ["/prices", "Prices"],
];

function layout(title: string, now: Date, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - just-buy-it dashboard</title>
<style>${STYLE}</style>
</head>
<body>
<nav>${NAV.map(([path, name]) => `<a href="${path}">${name}</a>`).join("")}</nav>
<h1>${escapeHtml(title)}</h1>
<p class="muted">${escapeHtml(formatAsOf(now))}</p>
${body}
</body>
</html>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "21 Oct 14:32 CEST": rows reach back months, so the date is shown with the time.
function time(at: Date | null): string {
  if (at === null) return "-";
  const t = berlinWallTime(at);
  return `${t.day} ${MONTHS[t.month - 1]} ${formatBerlinTime(at)}`;
}

const yesNo = (value: boolean): string => (value ? "yes" : "no");

// A table row of already escaped cells.
const row = (cells: readonly string[]): string => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;

function table(headers: readonly string[], rows: readonly string[]): string {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr>`;
  return `<table>${head}${rows.join("")}</table>`;
}

// Name and value pairs; values are escaped here.
function fields(pairs: readonly [string, string][]): string {
  return `<table>${pairs.map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`).join("")}</table>`;
}

function workerSection(worker: Overview["worker"]): string {
  if (worker === null) return `<h2>Worker</h2><p>No worker status yet.</p>`;
  return `<h2>Worker</h2>${fields([
    ["Commit", worker.gitSha],
    ["Started", time(worker.startedAt)],
    ["Last heartbeat", time(worker.heartbeatAt)],
    ["SMTP configured", yesNo(worker.smtpConfigured)],
    ["Claude configured", yesNo(worker.claudeConfigured)],
  ])}`;
}

const runStatus = (run: RunSummary): string => (run.stale ? "error (stale)" : run.status);
const list = (values: readonly (string | number)[]): string => (values.length === 0 ? "none" : values.join(", "));

function feedsSection(feeds: Overview["feeds"]): string {
  const rows = feeds.map((feed) => {
    const poll = feed.lastPoll;
    const pollCells =
      poll === null
        ? ["never", "-", "-", "-", "-", "-"]
        : [time(poll.startedAt), runStatus(poll), String(poll.items), String(poll.newItems), String(poll.candidates), list(poll.warningIds)];
    return row(
      [feed.id, yesNo(feed.enabled), yesNo(feed.baselineDone), ...pollCells, String(feed.failedInRow), String(feed.capReachedLast24h)].map(
        escapeHtml,
      ),
    );
  });
  return `<h2>Feeds</h2>${table(
    ["Feed", "Enabled", "Baseline done", "Last poll", "Status", "Items", "New", "Candidates", "Warnings", "Failed in a row", "Cap reached (24 h)"],
    rows,
  )}`;
}

// A key this release does not know (a v2 product key) is shown as it is.
const label = (segment: string): string => segmentLabel(segment);

function sweepsSection(sweeps: Overview["sweeps"]): string {
  const rows = sweeps.map(({ segment, lastSweep: run }) =>
    row(
      (run === null
        ? [label(segment), "never", "-", "-", "-"]
        : [label(segment), time(run.startedAt), runStatus(run), String(run.items), String(run.candidates)]
      ).map(escapeHtml),
    ),
  );
  return `<h2>Sweeps</h2>${table(["Segment", "Last sweep", "Status", "Items", "Candidates"], rows)}`;
}

function quotaSection(quota: Overview["quota"], calls: Overview["callsToday"]): string {
  const windows = quota.map((w) =>
    row(
      [
        w.resource,
        `${time(w.windowStart)} to ${time(w.windowEnd)}`,
        `${w.used} / ${w.limitTotal}`,
        String(w.usedAlertPath),
        String(w.usedStandard),
      ].map(escapeHtml),
    ),
  );
  const purposes = calls.map((c) => row([c.resource, c.purpose, String(c.calls)].map(escapeHtml)));
  return `<h2>eBay quota</h2>${table(["Resource", "Window", "Used / limit", "Alert path", "Standard"], windows)}
<h3>Calls today by purpose</h3>${table(["Resource", "Purpose", "Calls"], purposes)}`;
}

// Micro-USD as "USD 0.15".
const usd = (microusd: number, places = 2): string => `USD ${(microusd / 1_000_000).toFixed(places)}`;

function claudeSection(claude: Overview["claudeToday"]): string {
  const failures = claude.failures.map((f) => row([f.code, String(f.count)].map(escapeHtml)));
  // The caps live in the worker's environment, which the server does not read.
  return `<h2>Claude today</h2>${fields([
    [`Calls (${claude.day})`, String(claude.calls)],
    ["Spent", usd(claude.spentMicrousd)],
    ["Reserved", usd(claude.reservedMicrousd)],
    ["Screening paused until", claude.pausedUntil === null ? "not paused" : time(claude.pausedUntil)],
  ])}
<p class="muted">Caps: CLAUDE_DAILY_CALL_LIMIT and CLAUDE_DAILY_SPEND_LIMIT_USD in the worker environment (defaults 40 calls and USD 2.00 a Berlin day).</p>
<h3>Failures today by code</h3>${table(["Code", "Count"], failures)}`;
}

function emailSection(email: Overview["email"]): string {
  const pending = email.pending.map((p) => row([p.holdReason ?? "waiting", String(p.count)].map(escapeHtml)));
  return `<h2>Email</h2>${fields([
    ["Sent (24 h)", String(email.sent24h)],
    ["Failed (24 h)", String(email.failed24h)],
    ["SMTP paused until", email.pausedUntil === null ? "not paused" : time(email.pausedUntil)],
  ])}
<h3>Pending by hold reason</h3>${table(["Hold reason", "Count"], pending)}`;
}

function purgeSection(purge: Overview["lastPurge"]): string {
  if (purge === null) return `<h2>Purge</h2><p>No purge run yet.</p>`;
  return `<h2>Purge</h2>${fields([
    ["Started", time(purge.startedAt)],
    ["Finished", time(purge.finishedAt)],
    ["Status", purge.status],
    ["Counts", list(Object.entries(purge.counts).map(([step, count]) => `${step}: ${count}`))],
  ])}`;
}

const eur = (cents: number | null): string => (cents === null ? "-" : formatEur(cents));
const orDash = (value: string | number | null): string => (value === null ? "-" : String(value));

// Shipping and landed price are NULL while shipping is unknown (the price is set then) and once
// the 30-day purge removed every price.
const unknownUnlessGone = (cents: number | null, priceCents: number | null): string =>
  cents === null && priceCents !== null ? "unknown" : eur(cents);

// The link carries no tracking parameters (section 6.2); escaped cell content.
function ebayLink(legacyItemId: string | null): string {
  if (legacyItemId === null) return "-";
  return `<a href="https://www.ebay.de/itm/${escapeHtml(encodeURIComponent(legacyItemId))}">eBay</a>`;
}

export function candidatesHtml(data: CandidatesPage, now: Date): string {
  const today = data.today.map((t) =>
    row([label(t.segment), `${t.candidates} / ${t.cap}`, String(t.overCap), String(t.tooOld)].map(escapeHtml)),
  );
  const rows = data.candidates.map((c) =>
    row([
      ...[
        time(c.createdAt),
        label(c.segment),
        c.title ?? "content expired",
        eur(c.priceCents),
        unknownUnlessGone(c.shippingCents, c.priceCents),
        unknownUnlessGone(c.landedCents, c.priceCents),
        c.percentOfMax === null ? "-" : `${c.percentOfMax}%`,
        list(c.flags),
        c.decision,
        orDash(c.rejectReason),
        orDash(c.verdict),
      ].map(escapeHtml),
      ebayLink(c.legacyItemId),
    ]),
  );
  return layout(
    "Candidates",
    now,
    `<h2>Today per segment</h2>${table(["Segment", "Candidates / cap", "Over cap", "Too old"], today)}
<h2>Last 100 candidates</h2>${table(
      ["Time", "Segment", "Title", "Price", "Shipping", "Landed", "% of max", "Flags", "Decision", "Reject reason", "Verdict", "Link"],
      rows,
    )}`,
  );
}

export function blockedHtml(blocked: readonly BlockedRow[], now: Date): string {
  const rows = blocked.map((b) =>
    row([
      ...[
        time(b.createdAt),
        label(b.segment),
        eur(b.landedCents),
        list(b.flags),
        list(b.riskFlags),
        list(b.codeSignals),
        yesNo(b.blockedByCode),
        b.reason ?? "content expired",
      ].map(escapeHtml),
      ebayLink(b.legacyItemId),
    ]),
  );
  return layout(
    "Blocked",
    now,
    `<p>Alerts with the final verdict block. Blocked by code: no email was sent.</p>
${table(["Time", "Segment", "Landed", "Flags", "Risk flags", "Code signals", "Blocked by code", "Reason", "Link"], rows)}`,
  );
}

export function screeningsHtml(screenings: readonly ScreeningRow[], now: Date): string {
  const rows = screenings.map((s) =>
    row(
      [
        time(s.createdAt),
        s.status,
        orDash(s.verdict),
        list(s.riskFlags),
        orDash(s.failureCode),
        orDash(s.requestBytes),
        orDash(s.inputTokens),
        orDash(s.outputTokens),
        s.costMicrousd === null ? "-" : usd(s.costMicrousd, 4),
        s.latencyMs === null ? "-" : `${s.latencyMs} ms`,
        s.model,
      ].map(escapeHtml),
    ),
  );
  return layout(
    "Screenings",
    now,
    `<h2>Last 100 screenings</h2>${table(
      ["Time", "Status", "Verdict", "Risk flags", "Failure code", "Request bytes", "Input tokens", "Output tokens", "Cost", "Latency", "Model"],
      rows,
    )}`,
  );
}

export function rejectionsHtml(data: RejectionsPage, now: Date): string {
  const counts = data.counts.map((c) => row([c.feedId, c.outcome, String(c.count)].map(escapeHtml)));
  const samples = data.samples.map((s) =>
    row(
      [
        time(s.seenAt),
        s.feedId,
        s.segment === null ? "-" : label(s.segment),
        s.outcome,
        orDash(s.reason),
        eur(s.landedCents),
        s.title,
      ].map(escapeHtml),
    ),
  );
  return layout(
    "Rejections",
    now,
    `<h2>Last 24 h by feed and outcome</h2>${table(["Feed", "Outcome", "Count"], counts)}
<h2>Sample of the last 6 h</h2>
<p class="muted">Per feed and hour: the first 20 rejected and all accepted titles.</p>
${table(["Time", "Feed", "Segment", "Outcome", "Reason", "Landed", "Title"], samples)}`,
  );
}

type RuleValues = { maxLandedCents: number; floorCents: number } | { maxCentsPerGb: number; minCentsPerGb: number };

function ruleValues(values: RuleValues): string {
  if ("maxLandedCents" in values) return `max ${formatEur(values.maxLandedCents)}, floor ${formatEur(values.floorCents)}`;
  return `max ${formatEur(values.maxCentsPerGb)}/GB, floor ${formatEur(values.minCentsPerGb)}/GB`;
}

const NO_SUGGESTION: Record<"too_few" | "cut_off", string> = {
  too_few: `none: fewer than ${MIN_SAMPLES_FOR_SUGGESTION} samples`,
  cut_off: "none: the read is cut off, raise the read ceiling",
};

function windowLabel(window: PriceWindow): string {
  if (window.window === "last_24h") return "last 24 h";
  if (window.window === "last_7d") return "last 7 days";
  // No baseline poll yet: the query reads from the epoch.
  return window.since.getTime() === 0 ? "since baseline (no baseline yet)" : `since baseline (${time(window.since)})`;
}

export function pricesHtml(rows: readonly PricesRow[], now: Date): string {
  const sections = rows.map((segmentRow) => {
    // Quartiles are cents per item, or cents per GB for a per-GB segment.
    const quartile = (value: number | null): string => {
      if (value === null) return "-";
      const text = formatEur(Math.round(value));
      return segmentRow.current.kind === "per_gb" ? `${text}/GB` : text;
    };
    const windows = segmentRow.windows.map((w) =>
      row(
        [
          windowLabel(w),
          String(w.stats.n),
          quartile(w.stats.p25),
          quartile(w.stats.p50),
          quartile(w.stats.p75),
          w.suggestion.kind === "none" ? NO_SUGGESTION[w.suggestion.reason] : ruleValues(w.suggestion),
        ].map(escapeHtml),
      ),
    );
    return `<h2>${escapeHtml(label(segmentRow.segment))} (feed ${escapeHtml(segmentRow.feedId)})</h2>
<p>Current: ${escapeHtml(ruleValues(segmentRow.current))}</p>
${table(["Window", "n", "p25", "p50", "p75", "Suggested"], windows)}`;
  });
  return layout(
    "Prices",
    now,
    `<p class="muted">Landed asking prices of qualifying listings at first sighting by a poll. Suggestion: max = min(p25, 0.8 x p50), floor = 0.4 x p50, rounded down, from ${MIN_SAMPLES_FOR_SUGGESTION} samples.</p>
${sections.join("\n")}`,
  );
}

export function alertsHtml(alerts: readonly AlertRow[], now: Date): string {
  const rows = alerts.map((a) =>
    row(
      [
        time(a.createdAt),
        label(a.segment),
        eur(a.landedCents),
        a.finalVerdict,
        a.modelVerdict ?? "not screened",
        yesNo(a.blockedByCode),
        yesNo(a.screened),
        a.deliveryStatus ?? "no delivery",
        orDash(a.holdReason),
        orDash(a.attempt),
        orDash(a.lastErrorCode),
        time(a.sentAt),
      ].map(escapeHtml),
    ),
  );
  return layout(
    "Alerts",
    now,
    `<h2>Last 100 alerts</h2>${table(
      ["Time", "Segment", "Landed", "Final verdict", "Model verdict", "Blocked by code", "Screened", "Delivery", "Hold reason", "Attempts", "Last error", "Sent at"],
      rows,
    )}`,
  );
}

export function overviewHtml(data: Overview, now: Date): string {
  return layout(
    "Overview",
    now,
    [
      workerSection(data.worker),
      feedsSection(data.feeds),
      sweepsSection(data.sweeps),
      quotaSection(data.quota, data.callsToday),
      claudeSection(data.claudeToday),
      emailSection(data.email),
      purgeSection(data.lastPurge),
    ].join("\n"),
  );
}

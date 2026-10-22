import {
  FEED_IDS,
  SEGMENTS,
  berlinDay,
  effectiveRunStatus,
  priceStatistics,
  startOfBerlinDay,
  suggestRule,
  type FeedId,
  type PriceStatistics,
  type RuleSuggestion,
  type RunStatus,
  type Segment,
} from "@ebay-sniper/domain";
import { listFeeds, listSegmentRules } from "./feed.js";
import type { Queryable } from "./pool.js";
import { priceSamplesSince } from "./price-sample.js";
import type { WorkerStatus } from "./worker-status.js";

// Section 8.2: the read-only queries of the internal dashboard. They run as role dashboard and read
// only the tables and columns migration 0005 grants it. Times are returned as Date; the page
// formats them in Europe/Berlin.

const DAY_MS = 24 * 60 * 60 * 1000;
// Enough runs to count a breaker's 5 failures in a row and show a longer streak.
const RUNS_PER_FEED = 10;

export type RunSummary = {
  startedAt: Date;
  // A running row older than 5 minutes shows as error with stale = true ("error (stale)").
  status: RunStatus;
  stale: boolean;
};

export type FeedOverview = {
  id: FeedId;
  enabled: boolean;
  baselineDone: boolean;
  lastPoll: (RunSummary & { items: number; newItems: number; candidates: number; warningIds: number[] }) | null;
  failedInRow: number;
  capReachedLast24h: number;
};

export type Overview = {
  worker: WorkerStatus | null;
  feeds: FeedOverview[];
  sweeps: { segment: Segment; lastSweep: (RunSummary & { items: number; candidates: number }) | null }[];
  quota: {
    resource: string;
    windowStart: Date;
    windowEnd: Date;
    limitTotal: number;
    used: number;
    usedAlertPath: number;
    usedStandard: number;
  }[];
  callsToday: { resource: string; purpose: string; calls: number }[];
  claudeToday: {
    day: string;
    calls: number;
    reservedMicrousd: number;
    spentMicrousd: number;
    failures: { code: string; count: number }[];
    pausedUntil: Date | null;
  };
  email: { pending: { holdReason: string | null; count: number }[]; sent24h: number; failed24h: number; pausedUntil: Date | null };
  lastPurge: { startedAt: Date; finishedAt: Date | null; status: string; counts: Record<string, number> } | null;
};

type RunDb = {
  feed_id: FeedId;
  segment: Segment | null;
  started_at: Date;
  finished_at: Date | null;
  status: RunStatus;
  items: number;
  new_items: number;
  candidates: number;
  warning_ids: number[];
};

function summary(row: RunDb, now: Date): RunSummary {
  const status = effectiveRunStatus({ status: row.status, startedAt: row.started_at, finishedAt: row.finished_at }, now);
  return { startedAt: row.started_at, status, stale: row.status === "running" && status === "error" };
}

const PAGE_ROWS = 100;

type RuleLimits = { segment: Segment; rule_kind: "per_item" | "per_gb"; max_landed_cents: number | null; max_cents_per_gb: number | null };

// The landed price (or the item price while shipping is unknown) as a whole percentage of the
// segment's max; per GB against the per-GB max. null without a rule or size.
function percentOfMax(
  rule: RuleLimits | undefined,
  price: { priceCents: number | null; landedCents: number | null; totalGb: number | null },
): number | null {
  const checked = price.landedCents ?? price.priceCents;
  if (rule === undefined || checked === null) return null;
  if (rule.rule_kind === "per_item") {
    return rule.max_landed_cents === null ? null : Math.round((100 * checked) / rule.max_landed_cents);
  }
  if (rule.max_cents_per_gb === null || price.totalGb === null || price.totalGb <= 0) return null;
  return Math.round((100 * checked) / price.totalGb / rule.max_cents_per_gb);
}

async function ruleLimits(db: Queryable): Promise<Map<Segment, RuleLimits>> {
  const result = await db.query<RuleLimits>("SELECT segment, rule_kind, max_landed_cents, max_cents_per_gb FROM app.segment_rule");
  return new Map(result.rows.map((row) => [row.segment, row]));
}

export type CandidateRow = {
  createdAt: Date;
  segment: Segment;
  // null once the content expired: no title and no link.
  title: string | null;
  priceCents: number | null;
  shippingCents: number | null;
  landedCents: number | null;
  percentOfMax: number | null;
  flags: string[];
  decision: string;
  rejectReason: string | null;
  verdict: string | null;
  legacyItemId: string | null;
};

export type CandidatesPage = {
  candidates: CandidateRow[];
  today: { segment: Segment; candidates: number; cap: number; overCap: number; tooOld: number }[];
};

export async function candidatesPage(db: Queryable, now: Date): Promise<CandidatesPage> {
  const dayStart = startOfBerlinDay(now);
  const rules = await ruleLimits(db);
  const rows = await db.query<{
    created_at: Date;
    segment: Segment;
    price_cents: number | null;
    shipping_cents: number | null;
    landed_cents: number | null;
    total_gb: number | null;
    flags: string[];
    decision: string;
    reject_reason: string | null;
    title: string | null;
    legacy_item_id: string | null;
    verdict: string | null;
  }>(
    `SELECT c.created_at, c.segment, c.price_cents, c.shipping_cents, c.landed_cents, c.total_gb, c.flags, c.decision,
            c.reject_reason,
            CASE WHEN lc.content_expires_at > $1 THEN lc.title END AS title,
            CASE WHEN l.gone_at IS NULL AND l.content_expires_at > $1 THEN l.legacy_item_id END AS legacy_item_id,
            s.verdict
       FROM app.candidate c
       LEFT JOIN ebay_live.listing l ON l.id = c.listing_id
       LEFT JOIN ebay_live.listing_content lc ON lc.listing_id = c.listing_id
       LEFT JOIN LATERAL (
         SELECT verdict FROM app.screening sc WHERE sc.item_key = c.item_key ORDER BY sc.created_at DESC LIMIT 1
       ) s ON true
      ORDER BY c.created_at DESC LIMIT $2`,
    [now, PAGE_ROWS],
  );
  const today = await db.query<{ segment: Segment; cap: number; candidates: number; over_cap: number; too_old: number }>(
    `SELECT r.segment, r.candidate_cap_per_day AS cap,
            (SELECT count(*)::int FROM app.candidate c WHERE c.segment = r.segment AND c.created_at >= $2) AS candidates,
            (SELECT count(*)::int FROM app.seen_item s WHERE s.segment = r.segment AND s.outcome = 'over_cap' AND s.last_seen_at >= $2) AS over_cap,
            (SELECT count(*)::int FROM app.seen_item s WHERE s.segment = r.segment AND s.outcome = 'too_old' AND s.last_seen_at >= $2) AS too_old
       FROM app.segment_rule r ORDER BY array_position($1::text[], r.segment)`,
    [SEGMENTS, dayStart],
  );
  return {
    candidates: rows.rows.map((row) => ({
      createdAt: row.created_at,
      segment: row.segment,
      title: row.title,
      priceCents: row.price_cents,
      shippingCents: row.shipping_cents,
      landedCents: row.landed_cents,
      percentOfMax: percentOfMax(rules.get(row.segment), {
        priceCents: row.price_cents,
        landedCents: row.landed_cents,
        totalGb: row.total_gb,
      }),
      flags: row.flags,
      decision: row.decision,
      rejectReason: row.reject_reason,
      verdict: row.verdict,
      legacyItemId: row.legacy_item_id,
    })),
    today: today.rows.map((row) => ({
      segment: row.segment,
      candidates: row.candidates,
      cap: row.cap,
      overCap: row.over_cap,
      tooOld: row.too_old,
    })),
  };
}

export type AlertRow = {
  createdAt: Date;
  segment: Segment;
  landedCents: number | null;
  finalVerdict: string;
  modelVerdict: string | null;
  blockedByCode: boolean;
  screened: boolean;
  // null for an alert without a delivery (blocked by code).
  deliveryStatus: string | null;
  holdReason: string | null;
  attempt: number | null;
  lastErrorCode: string | null;
  sentAt: Date | null;
};

export async function alertsPage(db: Queryable, now: Date): Promise<AlertRow[]> {
  const result = await db.query<{
    created_at: Date;
    segment: Segment;
    landed_cents: number | null;
    final_verdict: string;
    model_verdict: string | null;
    blocked_by_code: boolean;
    screened: boolean;
    status: string | null;
    hold_reason: string | null;
    attempt: number | null;
    last_error_code: string | null;
    sent_at: Date | null;
  }>(
    `SELECT a.created_at, a.segment, a.landed_cents, a.final_verdict, a.model_verdict, a.blocked_by_code, a.screened,
            d.status, d.hold_reason, d.attempt, d.last_error_code, d.sent_at
       FROM app.alert a
       LEFT JOIN LATERAL (
         SELECT * FROM app.alert_delivery x WHERE x.alert_id = a.id ORDER BY x.created_at DESC LIMIT 1
       ) d ON true
      WHERE a.created_at <= $1
      ORDER BY a.created_at DESC LIMIT $2`,
    [now, PAGE_ROWS],
  );
  return result.rows.map((row) => ({
    createdAt: row.created_at,
    segment: row.segment,
    landedCents: row.landed_cents,
    finalVerdict: row.final_verdict,
    modelVerdict: row.model_verdict,
    blockedByCode: row.blocked_by_code,
    screened: row.screened,
    deliveryStatus: row.status,
    holdReason: row.hold_reason,
    attempt: row.attempt,
    lastErrorCode: row.last_error_code,
    sentAt: row.sent_at,
  }));
}

export type BlockedRow = {
  alertId: string;
  createdAt: Date;
  segment: Segment;
  landedCents: number | null;
  flags: string[];
  riskFlags: string[];
  codeSignals: string[];
  blockedByCode: boolean;
  // Claude's reason and the eBay link only while the listing content exists.
  reason: string | null;
  legacyItemId: string | null;
};

export async function blockedPage(db: Queryable, now: Date): Promise<BlockedRow[]> {
  const result = await db.query<{
    id: string;
    created_at: Date;
    segment: Segment;
    landed_cents: number | null;
    flags: string[];
    risk_flags: string[] | null;
    code_signals: string[] | null;
    blocked_by_code: boolean;
    reason: string | null;
    legacy_item_id: string | null;
  }>(
    `SELECT a.id, a.created_at, a.segment, a.landed_cents, a.flags, s.risk_flags, s.code_signals, a.blocked_by_code,
            CASE WHEN t.expires_at > $1 THEN t.reason END AS reason,
            CASE WHEN l.gone_at IS NULL AND l.content_expires_at > $1 THEN l.legacy_item_id END AS legacy_item_id
       FROM app.alert a
       LEFT JOIN app.screening s ON s.id = a.screening_id
       LEFT JOIN ebay_live.screening_text t ON t.screening_id = a.screening_id
       LEFT JOIN app.candidate c ON c.id = a.candidate_id
       LEFT JOIN ebay_live.listing l ON l.id = c.listing_id
      WHERE a.final_verdict = 'block'
      ORDER BY a.created_at DESC LIMIT $2`,
    [now, PAGE_ROWS],
  );
  return result.rows.map((row) => ({
    alertId: row.id,
    createdAt: row.created_at,
    segment: row.segment,
    landedCents: row.landed_cents,
    flags: row.flags,
    riskFlags: row.risk_flags ?? [],
    codeSignals: row.code_signals ?? [],
    blockedByCode: row.blocked_by_code,
    reason: row.reason,
    legacyItemId: row.legacy_item_id,
  }));
}

export type ScreeningRow = {
  createdAt: Date;
  status: string;
  verdict: string | null;
  riskFlags: string[];
  failureCode: string | null;
  requestBytes: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costMicrousd: number | null;
  latencyMs: number | null;
  model: string;
};

export async function screeningsPage(db: Queryable, now: Date): Promise<ScreeningRow[]> {
  const result = await db.query<{
    created_at: Date;
    status: string;
    verdict: string | null;
    risk_flags: string[];
    failure_code: string | null;
    request_bytes: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cost_microusd: number | null;
    latency_ms: number | null;
    model: string;
  }>(
    `SELECT created_at, status, verdict, risk_flags, failure_code, request_bytes, input_tokens, output_tokens, cost_microusd,
            latency_ms, model
       FROM app.screening WHERE created_at <= $1 ORDER BY created_at DESC LIMIT $2`,
    [now, PAGE_ROWS],
  );
  return result.rows.map((row) => ({
    createdAt: row.created_at,
    status: row.status,
    verdict: row.verdict,
    riskFlags: row.risk_flags,
    failureCode: row.failure_code,
    requestBytes: row.request_bytes,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicrousd: row.cost_microusd,
    latencyMs: row.latency_ms,
    model: row.model,
  }));
}

export type RejectionsPage = {
  // Sightings of the last 24 h by feed and seen_item outcome.
  counts: { feedId: FeedId; outcome: string; count: number }[];
  // The unexpired classifier sample: the first 20 rejected and all accepted titles per feed and hour.
  samples: {
    feedId: FeedId;
    segment: Segment | null;
    title: string;
    landedCents: number | null;
    outcome: string;
    reason: string | null;
    seenAt: Date;
  }[];
};

export async function rejectionsPage(db: Queryable, now: Date): Promise<RejectionsPage> {
  const counts = await db.query<{ feed_id: FeedId; outcome: string; count: number }>(
    `SELECT feed_id, outcome, count(*)::int AS count FROM app.seen_item
      WHERE last_seen_at >= $1 GROUP BY feed_id, outcome ORDER BY feed_id, outcome`,
    [new Date(now.getTime() - DAY_MS)],
  );
  const samples = await db.query<{
    feed_id: FeedId;
    segment: Segment | null;
    title: string;
    landed_cents: number | null;
    outcome: string;
    reason: string | null;
    seen_at: Date;
  }>(
    `SELECT feed_id, segment, title, landed_cents, outcome, reason, seen_at FROM ebay_live.classifier_sample
      WHERE expires_at > $1 ORDER BY feed_id, seen_at DESC, id`,
    [now],
  );
  return {
    counts: counts.rows.map((row) => ({ feedId: row.feed_id, outcome: row.outcome, count: row.count })),
    samples: samples.rows.map((row) => ({
      feedId: row.feed_id,
      segment: row.segment,
      title: row.title,
      landedCents: row.landed_cents,
      outcome: row.outcome,
      reason: row.reason,
      seenAt: row.seen_at,
    })),
  };
}

export type PriceWindow = {
  window: "since_baseline" | "last_24h" | "last_7d";
  since: Date;
  stats: PriceStatistics;
  suggestion: RuleSuggestion;
};

export type PricesRow = {
  segment: Segment;
  feedId: FeedId;
  current: { kind: "per_item"; maxLandedCents: number; floorCents: number } | { kind: "per_gb"; maxCentsPerGb: number; minCentsPerGb: number };
  windows: PriceWindow[];
};

// Section 3.5: per segment and window n, p25, p50, p75, the current max and floor, and the
// suggestion or the reason there is none. "Since baseline" starts at the feed's newest baseline poll.
export async function pricesPage(db: Queryable, now: Date): Promise<PricesRow[]> {
  const feeds = new Map((await listFeeds(db)).map((feed) => [feed.id, feed]));
  const baselines = await db.query<{ feed_id: FeedId; started_at: Date }>(
    `SELECT feed_id, max(started_at) AS started_at FROM app.poll_run
      WHERE kind = 'poll' AND baseline GROUP BY feed_id`,
  );
  const baselineOf = new Map(baselines.rows.map((row) => [row.feed_id, row.started_at]));
  const rows: PricesRow[] = [];
  for (const rule of await listSegmentRules(db)) {
    const ceiling = feeds.get(rule.feedId)?.priceCeilingCents ?? 0;
    const windows: [PriceWindow["window"], Date][] = [
      ["since_baseline", baselineOf.get(rule.feedId) ?? new Date(0)],
      ["last_24h", new Date(now.getTime() - DAY_MS)],
      ["last_7d", new Date(now.getTime() - 7 * DAY_MS)],
    ];
    const read: PriceWindow[] = [];
    for (const [window, since] of windows) {
      const stats = priceStatistics(await priceSamplesSince(db, rule.segment, since), rule.kind);
      read.push({ window, since, stats, suggestion: suggestRule(stats, rule.kind, ceiling) });
    }
    rows.push({
      segment: rule.segment,
      feedId: rule.feedId,
      current:
        rule.kind === "per_item"
          ? { kind: "per_item", maxLandedCents: rule.maxLandedCents, floorCents: rule.floorCents }
          : { kind: "per_gb", maxCentsPerGb: rule.maxCentsPerGb, minCentsPerGb: rule.minCentsPerGb },
      windows: read,
    });
  }
  return rows;
}

export async function overviewPage(db: Queryable, now: Date): Promise<Overview> {
  const dayStart = startOfBerlinDay(now);
  const day = berlinDay(now);
  const since24h = new Date(now.getTime() - DAY_MS);

  const worker = await db.query<{
    git_sha: string;
    started_at: Date;
    heartbeat_at: Date;
    smtp_configured: boolean;
    claude_configured: boolean;
  }>("SELECT git_sha, started_at, heartbeat_at, smtp_configured, claude_configured FROM app.worker_status WHERE id = 1");
  const feeds = await db.query<{ id: FeedId; enabled: boolean; baseline_done: boolean; cap_reached: number }>(
    `SELECT f.id, f.enabled,
            EXISTS (SELECT 1 FROM app.seen_item s WHERE s.feed_id = f.id) AS baseline_done,
            (SELECT count(*)::int FROM app.poll_run r
              WHERE r.feed_id = f.id AND r.kind = 'poll' AND r.cap_reached AND r.started_at >= $2) AS cap_reached
       FROM app.feed f ORDER BY array_position($1::text[], f.id)`,
    [FEED_IDS, since24h],
  );
  const polls = await db.query<RunDb>(
    `SELECT r.feed_id, r.segment, r.started_at, r.finished_at, r.status, r.items, r.new_items, r.candidates, r.warning_ids
       FROM app.feed f
       CROSS JOIN LATERAL (
         SELECT * FROM app.poll_run p WHERE p.feed_id = f.id AND p.kind = 'poll' ORDER BY p.started_at DESC LIMIT $1
       ) r
      ORDER BY r.started_at DESC`,
    [RUNS_PER_FEED],
  );
  const sweeps = await db.query<RunDb>(
    `SELECT DISTINCT ON (segment) feed_id, segment, started_at, finished_at, status, items, new_items, candidates, warning_ids
       FROM app.poll_run WHERE kind = 'sweep' ORDER BY segment, started_at DESC`,
  );
  const quota = await db.query<{
    resource: string;
    window_start: Date;
    window_end: Date;
    limit_total: number;
    used: number;
    used_alert_path: number;
    used_standard: number;
  }>(
    `SELECT resource, window_start, window_end, limit_total, used, used_alert_path, used_standard
       FROM app.ebay_quota_window WHERE window_start <= $1 AND $1 < window_end ORDER BY resource`,
    [now],
  );
  const calls = await db.query<{ resource: string; purpose: string; calls: number }>(
    `SELECT resource, purpose, sum(calls)::int AS calls FROM app.api_usage_hourly
      WHERE hour_utc >= $1 GROUP BY resource, purpose ORDER BY resource, purpose`,
    [dayStart],
  );
  const usage = await db.query<{ calls: number; reserved: string; spent: string }>(
    "SELECT calls, reserved_microusd AS reserved, spent_microusd AS spent FROM app.llm_usage_daily WHERE day_berlin = $1::date",
    [day],
  );
  const failures = await db.query<{ code: string; count: number }>(
    `SELECT failure_code AS code, count(*)::int AS count FROM app.screening
      WHERE failure_code IS NOT NULL AND created_at >= $1 GROUP BY failure_code ORDER BY failure_code`,
    [dayStart],
  );
  const pauses = await db.query<{ screening: Date | null; smtp: Date | null }>(
    `SELECT (SELECT until FROM app.screening_pause WHERE until > $1) AS screening,
            (SELECT until FROM app.smtp_pause WHERE until > $1) AS smtp`,
    [now],
  );
  const pending = await db.query<{ hold_reason: string | null; count: number }>(
    `SELECT hold_reason, count(*)::int AS count FROM app.alert_delivery WHERE status = 'pending'
      GROUP BY hold_reason ORDER BY hold_reason NULLS FIRST`,
  );
  const email = await db.query<{ sent: number; failed: number }>(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at >= $1)::int AS sent,
            count(*) FILTER (WHERE status = 'failed' AND created_at >= $1)::int AS failed
       FROM app.alert_delivery`,
    [since24h],
  );
  const purge = await db.query<{ started_at: Date; finished_at: Date | null; status: string; counts: Record<string, number> }>(
    "SELECT started_at, finished_at, status, counts FROM app.purge_run ORDER BY started_at DESC LIMIT 1",
  );

  const w = worker.rows[0];
  const u = usage.rows[0];
  const p = purge.rows[0];
  return {
    worker:
      w === undefined
        ? null
        : {
            gitSha: w.git_sha,
            startedAt: w.started_at,
            heartbeatAt: w.heartbeat_at,
            smtpConfigured: w.smtp_configured,
            claudeConfigured: w.claude_configured,
          },
    feeds: feeds.rows.map((feed) => {
      const runs = polls.rows.filter((run) => run.feed_id === feed.id);
      const newest = runs[0];
      let failedInRow = 0;
      for (const run of runs) {
        if (summary(run, now).status !== "error") break;
        failedInRow += 1;
      }
      return {
        id: feed.id,
        enabled: feed.enabled,
        baselineDone: feed.baseline_done,
        lastPoll:
          newest === undefined
            ? null
            : {
                ...summary(newest, now),
                items: newest.items,
                newItems: newest.new_items,
                candidates: newest.candidates,
                warningIds: newest.warning_ids,
              },
        failedInRow,
        capReachedLast24h: feed.cap_reached,
      };
    }),
    sweeps: SEGMENTS.map((segment) => {
      const run = sweeps.rows.find((row) => row.segment === segment);
      return {
        segment,
        lastSweep: run === undefined ? null : { ...summary(run, now), items: run.items, candidates: run.candidates },
      };
    }),
    quota: quota.rows.map((row) => ({
      resource: row.resource,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      limitTotal: row.limit_total,
      used: row.used,
      usedAlertPath: row.used_alert_path,
      usedStandard: row.used_standard,
    })),
    callsToday: calls.rows,
    claudeToday: {
      day,
      calls: u?.calls ?? 0,
      reservedMicrousd: Number(u?.reserved ?? 0),
      spentMicrousd: Number(u?.spent ?? 0),
      failures: failures.rows,
      pausedUntil: pauses.rows[0]?.screening ?? null,
    },
    email: {
      pending: pending.rows.map((row) => ({ holdReason: row.hold_reason, count: row.count })),
      sent24h: email.rows[0]?.sent ?? 0,
      failed24h: email.rows[0]?.failed ?? 0,
      pausedUntil: pauses.rows[0]?.smtp ?? null,
    },
    lastPurge: p === undefined ? null : { startedAt: p.started_at, finishedAt: p.finished_at, status: p.status, counts: p.counts },
  };
}

// The page queries above, by page name.
export const DASHBOARD_QUERIES: Record<string, (db: Queryable, now: Date) => Promise<unknown>> = {
  overview: overviewPage,
  candidates: candidatesPage,
  alerts: alertsPage,
  blocked: blockedPage,
  screenings: screeningsPage,
  rejections: rejectionsPage,
  prices: pricesPage,
};

import {
  claimCandidate,
  confirmListings,
  countCandidatesSince,
  feedHasSeenItems,
  finishPollRun,
  getSeenItems,
  insertCandidate,
  insertClassifierSamples,
  insertListing,
  insertPriceSamples,
  listFeeds,
  listSegmentRules,
  overflowPagesSince,
  startPollRun,
  upsertListingContent,
  upsertSeenItems,
  type ClassifierSampleRow,
  type DbPool,
  type ListingContentInput,
  type PollRunErrorKind,
  type PollRunStart,
  type PriceSampleRow,
  type Queryable,
  type SeenItemSighting,
} from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import {
  classifyListing,
  decideSighting,
  nextPageDecision,
  pollPriceFilter,
  startOfBerlinDay,
  toListingCandidate,
  type ClassifyResult,
  type Clock,
  type FeedId,
  type ListingCandidate,
  type RunStatus,
  type Segment,
  type SegmentRule,
} from "@ebay-sniper/domain";
import {
  buildFeedSearch,
  EbayError,
  FEED_PAGE_LIMIT,
  type BrowseCallContext,
  type BrowseSearchPage,
  type BrowseSearchRequest,
  type ItemSummary,
  type ReserveEbayCall,
} from "@ebay-sniper/ebay";
import type { ItemKey, ItemKeyFn } from "../item-key.js";

export type LogFn = (entry: Record<string, unknown>) => void;

export type BrowseSearch = (request: BrowseSearchRequest, call: BrowseCallContext) => Promise<BrowseSearchPage>;

// What the poll and sweep handlers need. The search is built per run on a reservation the run
// counts, so poll_run.calls is every reserved attempt, retries included.
export type SearchDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  reserve: ReserveEbayCall;
  createSearch: (reserve: ReserveEbayCall) => BrowseSearch;
  itemKey: ItemKeyFn;
  postalCode: string;
  log: { info: LogFn; warn: LogFn };
};

// Polls and sweeps are the standard class: they stop at 3,500 used units (section 3.4).
const STANDARD_MIN_LEFT = 1500;

// The statements of fn run on one client inside BEGIN and COMMIT; a throw rolls them back.
export async function inTransaction<T>(pool: DbPool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      // A client that cannot roll back is not put back into the pool.
      broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    });
    throw error;
  } finally {
    client.release(broken);
  }
}

type RunCounts = {
  pages: number;
  items: number;
  malformed: number;
  newItems: number;
  candidates: number;
  capReached: boolean;
  warningIds: Set<number>;
  calls: number;
};

export type SearchRun = {
  counts: RunCounts;
  fetch(request: BrowseSearchRequest, purpose: "poll" | "sweep"): Promise<BrowseSearchPage>;
};

// Section 2.3: the run row is inserted as running before the first request and finished in finally.
export async function trackRun(
  deps: SearchDeps,
  start: PollRunStart,
  options: { enabled: boolean; signal: AbortSignal; logFields: Record<string, unknown> },
  body: (run: SearchRun) => Promise<void>,
): Promise<void> {
  const { signal } = options;
  const runId = await startPollRun(deps.pool, start);
  const counts: RunCounts = {
    pages: 0,
    items: 0,
    malformed: 0,
    newItems: 0,
    candidates: 0,
    capReached: false,
    warningIds: new Set(),
    calls: 0,
  };
  const search = deps.createSearch(async (reservation) => {
    const answer = await deps.reserve(reservation);
    if (answer === "ok") counts.calls += 1;
    return answer;
  });
  const run: SearchRun = {
    counts,
    async fetch(request, purpose) {
      // A cached token would let an aborted job reserve a unit before fetch notices the abort.
      signal.throwIfAborted();
      const page = await search(request, { callClass: "standard", purpose, minLeft: STANDARD_MIN_LEFT, signal });
      counts.pages += 1;
      counts.malformed += page.malformedItems;
      for (const warning of page.warnings) if (warning.errorId !== undefined) counts.warningIds.add(warning.errorId);
      return page;
    },
  };

  // A feed or rule paused after the job was queued is recorded as paused and sends nothing.
  let status: Exclude<RunStatus, "running"> = options.enabled ? "ok" : "paused";
  let errorKind: PollRunErrorKind | null = null;
  let thrown: unknown;
  let rethrow = false;
  try {
    if (options.enabled) await body(run);
  } catch (error) {
    ({ status, errorKind } = failureOf(error, signal));
    thrown = error;
    // eBay failures and the deadline are recorded and end the job (the next tick is the retry);
    // anything else is thrown after the row is finished.
    rethrow = !(error instanceof EbayError) && errorKind !== "deadline";
  } finally {
    const warningIds = [...counts.warningIds].sort((a, b) => a - b);
    await finishPollRun(deps.pool, runId, {
      status,
      finishedAt: deps.clock.now(),
      pages: counts.pages,
      items: counts.items,
      malformed: counts.malformed,
      newItems: counts.newItems,
      candidates: counts.candidates,
      capReached: counts.capReached,
      warningIds,
      errorKind,
      calls: counts.calls,
    });
    if (status === "quota_refused") deps.log.warn({ event: "quota_refused", run_id: runId, ...options.logFields });
    const ebay = thrown instanceof EbayError ? { ebay_error: thrown.kind, ebay_status: thrown.status ?? null } : {};
    deps.log.info({
      event: "poll_run",
      run_id: runId,
      ...options.logFields,
      status,
      error_kind: errorKind,
      ...ebay,
      pages: counts.pages,
      items: counts.items,
      malformed: counts.malformed,
      new_items: counts.newItems,
      candidates: counts.candidates,
      cap_reached: counts.capReached,
      warning_ids: warningIds,
      calls: counts.calls,
    });
  }
  if (rethrow) throw thrown;
}

type Failure = { status: "error" | "quota_refused"; errorKind: PollRunErrorKind | null };

const EBAY_ERROR_KINDS: Partial<Record<EbayError["kind"], PollRunErrorKind>> = {
  aborted: "deadline",
  timeout: "timeout",
  network: "network",
  server_error: "http_5xx",
  invalid_response: "invalid_response",
};

// eBay 401, 429 and other 4xx have no error_kind of their own; the log line carries the eBay kind.
function failureOf(error: unknown, signal: AbortSignal): Failure {
  if (error instanceof EbayError) {
    if (error.kind === "quota_refused") return { status: "quota_refused", errorKind: null };
    return { status: "error", errorKind: EBAY_ERROR_KINDS[error.kind] ?? null };
  }
  if (signal.aborted) return { status: "error", errorKind: "deadline" };
  return { status: "error", errorKind: "db" };
}

export type RulesBySegment = Record<Segment, SegmentRule>;

// Migration 0006 seeds a rule for every segment; a missing row stops the run instead of
// classifying against nothing.
export function rulesBySegment(rules: readonly SegmentRule[]): RulesBySegment {
  const rule = (segment: Segment): SegmentRule => {
    const found = rules.find((r) => r.segment === segment);
    if (found === undefined) throw new Error(`segment ${segment} has no rule`);
    return found;
  };
  return {
    gpu_3090: rule("gpu_3090"),
    gpu_3090ti: rule("gpu_3090ti"),
    gpu_4090: rule("gpu_4090"),
    ram_ddr4: rule("ram_ddr4"),
    ram_ddr5: rule("ram_ddr5"),
    pc_4090: rule("pc_4090"),
  };
}

export type PageContext = {
  feedId: FeedId;
  source: "poll" | "sweep";
  baseline: boolean;
  rules: RulesBySegment;
  now: Date;
};

type Sighting = {
  key: ItemKey;
  summary: ItemSummary;
  listing: ListingCandidate | null;
  classification: ClassifyResult;
};

const NOT_EUR: ClassifyResult = { outcome: "rejected", reason: "not_eur", segment: null, totalGb: null };

// Section 3.2 for one page: every sighting is written in one transaction (seen_item, price and
// classifier samples, confirmations). Returns whether every item was unseen before this page.
export async function processPage(
  deps: SearchDeps,
  run: SearchRun,
  page: BrowseSearchPage,
  ctx: PageContext,
): Promise<{ allUnseen: boolean }> {
  const sightings = new Map<string, Sighting>();
  for (const summary of page.items) {
    const parsed = toListingCandidate(summary, ctx.now);
    const legacyItemId = summary.legacyItemId;
    if ((!parsed.ok && parsed.reason === "malformed") || legacyItemId === undefined) {
      run.counts.malformed += 1;
      continue;
    }
    const key = deps.itemKey(legacyItemId);
    if (sightings.has(key.itemKey)) continue;
    const listing = parsed.ok ? parsed.listing : null;
    const classification = listing ? classifyListing(listing, ctx.feedId, ctx.rules) : NOT_EUR;
    sightings.set(key.itemKey, { key, summary, listing, classification });
  }
  run.counts.items += sightings.size;

  const existing = await getSeenItems(deps.pool, [...sightings.keys()]);
  const firstSightings = [...sightings.values()].filter((s) => !existing.has(s.key.itemKey));
  run.counts.newItems += firstSightings.length;

  const seen: SeenItemSighting[] = [];
  const prices: PriceSampleRow[] = [];
  const toCandidates: NewCandidate[] = [];
  // Candidates per segment this Berlin day: committed ones (earlier pages and runs included), plus
  // the ones this page makes.
  const today = new Map<Segment, number>();
  for (const sighting of sightings.values()) {
    const { key, listing, classification } = sighting;
    const segment = classification.segment;
    const before = existing.get(key.itemKey);
    const candidatesToday = segment
      ? (today.get(segment) ?? (await countCandidatesSince(deps.pool, segment, startOfBerlinDay(ctx.now))))
      : 0;
    const decision = decideSighting({
      source: ctx.source,
      baseline: ctx.baseline,
      existing: before ? { outcome: before.outcome, isCandidate: before.candidateAt !== null } : null,
      itemCreationAt: listing?.itemCreationAt ?? null,
      now: ctx.now,
      classification,
      candidatesToday,
      candidateCapPerDay: segment ? ctx.rules[segment].candidateCapPerDay : 0,
      segmentEnabled: segment ? ctx.rules[segment].enabled : true,
    });
    if (segment) today.set(segment, candidatesToday + (decision.makeCandidate ? 1 : 0));
    seen.push({ ...key, feedId: ctx.feedId, segment, outcome: decision.outcome, seenAt: ctx.now });
    if (decision.priceSample && segment && listing) {
      prices.push({
        segment,
        feedId: ctx.feedId,
        priceCents: listing.priceCents,
        shippingCents: listing.shippingCents,
        landedCents: listing.landedCents,
        totalGb: classification.totalGb,
        seenAt: ctx.now,
      });
    }
    if (decision.makeCandidate && segment && listing) toCandidates.push({ ...sighting, segment, listing });
  }

  // The classifier review (AC-29) reads first sightings; a later sighting repeats the same decision.
  const samples: ClassifierSampleRow[] = firstSightings.map(({ summary, listing, classification }) => ({
    feedId: ctx.feedId,
    segment: classification.segment,
    title: summary.title ?? "",
    landedCents: listing?.landedCents ?? null,
    outcome: classification.outcome === "candidate" ? "candidate" : "rejected",
    reason: classification.outcome === "rejected" ? classification.reason : null,
    seenAt: ctx.now,
  }));

  await inTransaction(deps.pool, async (client) => {
    // Rows are locked in key order, so a poll and a sweep on the same items never deadlock.
    await upsertSeenItems(client, [...seen].sort((a, b) => (a.itemKey < b.itemKey ? -1 : 1)));
    await insertPriceSamples(client, prices);
    await insertClassifierSamples(client, samples);
    await confirmListings(client, [...existing.keys()], ctx.now);
  });

  for (const candidate of toCandidates) {
    const listingId = await createCandidate(deps, candidate, ctx);
    // null: another run made the item a candidate first (section 2.4, candidate once).
    if (listingId === null) continue;
    run.counts.candidates += 1;
    deps.log.info({ event: "candidate_created", listing_id: listingId, segment: candidate.segment, source: ctx.source });
  }
  return { allUnseen: firstSightings.length === sightings.size };
}

type NewCandidate = Sighting & { segment: Segment; listing: ListingCandidate };

function summaryContent(summary: ItemSummary, listing: ListingCandidate): ListingContentInput {
  return {
    source: "summary",
    title: listing.title,
    condition: listing.conditionText,
    conditionDescription: null,
    sellerFeedbackScore: listing.seller.feedbackScore,
    sellerFeedbackPct: listing.seller.feedbackPercent,
    sellerAccountType: listing.seller.accountType,
    returnsAccepted: null,
    returnsDays: null,
    itemLocationCountry: summary.itemLocation?.country ?? null,
    aspects: null,
    descriptionText: null,
    imageCount: null,
    fetchedAt: listing.fetchedAt,
    contentExpiresAt: listing.contentExpiresAt,
  };
}

// One transaction per new candidate: only the run whose claim returns a row writes the listing, its
// summary content, the candidate and the enrich job, so a crash before commit leaves no job and
// no row.
async function createCandidate(deps: SearchDeps, candidate: NewCandidate, ctx: PageContext): Promise<string | null> {
  const { key, summary, listing, segment, classification } = candidate;
  return inTransaction(deps.pool, async (client) => {
    if (!(await claimCandidate(client, key.itemKey, ctx.now))) return null;
    const listingId = await insertListing(client, {
      ...key,
      itemId: listing.itemId,
      legacyItemId: listing.legacyItemId,
      feedId: ctx.feedId,
      segment,
      firstSeenAt: ctx.now,
      itemCreationAt: listing.itemCreationAt,
      itemEndAt: listing.itemEndAt,
      contentExpiresAt: listing.contentExpiresAt,
    });
    await upsertListingContent(client, listingId, summaryContent(summary, listing));
    await insertCandidate(client, {
      itemKey: key.itemKey,
      listingId,
      feedId: ctx.feedId,
      segment,
      source: ctx.source,
      priceCents: listing.priceCents,
      shippingCents: listing.shippingCents,
      landedCents: listing.landedCents,
      shippingKnown: listing.shippingKnown,
      totalGb: classification.totalGb,
      ruleVersion: ctx.rules[segment].ruleVersion,
      flags: classification.outcome === "candidate" ? classification.flags : [],
      createdAt: ctx.now,
    });
    await deps.queue.send("enrich", { listingId }, { db: client });
    return listingId;
  });
}

// Section 3.2: one poll of a feed, sort=newlyListed, the feed's price filter. A feed without any
// seen_item row polls a baseline: page 1 only, nothing becomes a candidate. Otherwise page 2 and 3
// follow only while every item of the page before was unseen, within the daily overflow limit.
export function createPollHandler(deps: SearchDeps): JobHandler<"poll"> {
  return async ({ feedId }, job) => {
    const now = deps.clock.now();
    const [feeds, rules] = await Promise.all([listFeeds(deps.pool), listSegmentRules(deps.pool)]);
    const feed = feeds.find((f) => f.id === feedId);
    if (feed === undefined) throw new Error(`feed ${feedId} is not configured`);
    const baseline = !(await feedHasSeenItems(deps.pool, feedId));
    const start: PollRunStart = { kind: "poll", feedId, baseline, startedAt: now };
    const logFields = { feed: feedId, kind: "poll", baseline };

    await trackRun(deps, start, { enabled: feed.enabled, signal: job.signal, logFields }, async (run) => {
      const ctx: PageContext = { feedId, source: "poll", baseline, rules: rulesBySegment(rules), now };
      const price = pollPriceFilter(feed, rules);
      const overflowUsed = await overflowPagesSince(deps.pool, feedId, startOfBerlinDay(now));
      for (let page = 1; ; page += 1) {
        const request = buildFeedSearch({
          q: feed.q,
          categoryId: feed.categoryId,
          conditionIds: feed.conditionIds,
          price,
          sort: "newlyListed",
          offset: (page - 1) * FEED_PAGE_LIMIT,
          postalCode: deps.postalCode,
        });
        const result = await run.fetch(request, "poll");
        const { allUnseen } = await processPage(deps, run, result, ctx);
        const next = nextPageDecision({
          page,
          allUnseen,
          hasMore: result.next !== undefined,
          baseline,
          overflowPagesUsedToday: overflowUsed + page - 1,
          overflowPagesPerDay: feed.overflowPagesPerDay,
        });
        if (next.capReached) run.counts.capReached = true;
        if (!next.fetchNext) return;
      }
    });
  };
}

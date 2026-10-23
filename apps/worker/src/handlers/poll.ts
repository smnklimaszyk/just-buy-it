import {
  claimCandidate,
  confirmListings,
  countCandidatesSince,
  finishPollRun,
  getSeenItems,
  insertCandidate,
  insertClassifierSamples,
  insertListing,
  insertPriceSamples,
  listProducts,
  loadSearch,
  loadSettings,
  okMarketValuesBetween,
  overflowPagesSince,
  startPollRun,
  upsertListingContent,
  upsertSeenItems,
  type CandidateProductFields,
  type ClassifierSampleRow,
  type DbPool,
  type ListingContentInput,
  type PollRunErrorKind,
  type PollRunStart,
  type PriceSampleRow,
  type Queryable,
  type SearchRow,
  type SeenItemSighting,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobHandler, JobQueue } from "@ebay-sniper/db/queue";
import {
  conditionGroupOf,
  decideSighting,
  MARKET_VALUE_MAX_AGE_MS,
  matchListing,
  nextPageDecision,
  OVERFLOW_PAGES_PER_SEARCH,
  resolveLimit,
  startOfBerlinDay,
  toListingCandidate,
  type Clock,
  type ConditionGroup,
  type LimitResolution,
  type ListingCandidate,
  type MarketValueRef,
  type MatchProduct,
  type MatchResult,
  type RunStatus,
  type SettingsEnv,
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
// counts, so poll_run.calls is every reserved attempt, retries included. settingsEnv bounds the
// settings read at the start of each job (spec 2.5, 9).
export type SearchDeps = {
  pool: DbPool;
  queue: Pick<JobQueue, "send">;
  clock: Clock;
  reserve: ReserveEbayCall;
  createSearch: (reserve: ReserveEbayCall) => BrowseSearch;
  itemKey: ItemKeyFn;
  postalCode: string;
  settingsEnv: SettingsEnv;
  log: { info: LogFn; warn: LogFn };
};

// Polls and sweeps are the standard class: they stop at 3,500 used units (spec 5.4).
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
  // Listings more than one product matched (spec 3.4); logged, poll_run has no column for it.
  ambiguous: number;
  capReached: boolean;
  warningIds: Set<number>;
  calls: number;
};

export type SearchRun = {
  counts: RunCounts;
  fetch(request: BrowseSearchRequest, purpose: "poll" | "sweep"): Promise<BrowseSearchPage>;
};

// The run row is inserted as running before the first request and finished in finally. A null
// body records the run as paused and sends nothing: the search or product is gone, retired,
// paused or archived since the job was queued (spec 9).
export async function trackRun(
  deps: SearchDeps,
  start: PollRunStart,
  options: { signal: AbortSignal; logFields: Record<string, unknown> },
  body: ((run: SearchRun) => Promise<void>) | null,
): Promise<void> {
  const { signal } = options;
  const runId = await startPollRun(deps.pool, start);
  const counts: RunCounts = {
    pages: 0,
    items: 0,
    malformed: 0,
    newItems: 0,
    candidates: 0,
    ambiguous: 0,
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

  let status: Exclude<RunStatus, "running"> = body ? "ok" : "paused";
  let errorKind: PollRunErrorKind | null = null;
  let thrown: unknown;
  let rethrow = false;
  try {
    if (body) await body(run);
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
      ambiguous: counts.ambiguous,
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

// What a page is matched against. feedId is what v2 writes into feed_id of seen_item, listing,
// candidate and poll_run: the search id for a poll, the product key for a sweep.
export type PageContext = {
  feedId: string;
  source: "poll" | "sweep";
  // At least one; active or paused. A paused product records sightings and makes no candidates.
  products: readonly StoredProduct[];
  lowFeedbackBelow: number;
  now: Date;
};

type Sighting = {
  key: ItemKey;
  summary: ItemSummary;
  listing: ListingCandidate | null;
};

const NOT_EUR: MatchResult = {
  productKey: null,
  outcome: "not_eur",
  flags: [],
  unitTotal: null,
  conditionGroup: null,
  ambiguous: false,
};

// The condition groups a product watches, each with its limit for one first-sighting time.
type ResolvedProduct = { product: StoredProduct; match: MatchProduct; limits: Map<ConditionGroup, LimitResolution> };

export function conditionGroups(product: StoredProduct): ConditionGroup[] {
  const groups = product.rules.conditionIds.map(conditionGroupOf).filter((group) => group !== null);
  return [...new Set(groups)];
}

// Spec 6.4: the limit of each watched group for a listing first seen at `at`, seen again `now`.
function resolveProducts(
  products: readonly StoredProduct[],
  values: Map<string, MarketValueRef[]>,
  at: Date,
  now: Date,
): ResolvedProduct[] {
  return products.map((product) => {
    const limitProduct = { ...product.rules, matchVersion: product.matchVersion };
    const limits = new Map(
      conditionGroups(product).map((group) => [group, resolveLimit(limitProduct, group, values.get(product.id) ?? [], at, now)] as const),
    );
    return { product, limits, match: { key: product.key, ...product.rules, limits: Object.fromEntries(limits) } };
  });
}

type NewCandidate = Sighting & {
  listing: ListingCandidate;
  product: StoredProduct;
  match: MatchResult;
  productFields: CandidateProductFields;
  // The first sighting, the `at` of the limit (spec 6.4), so enrich and screen resolve it alike.
  firstSeenAt: Date;
};

// One page: every sighting is matched against the page's products and written in one transaction
// (seen_item, price and classifier samples, confirmations). Returns whether every item was unseen
// before this page.
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
    sightings.set(key.itemKey, { key, summary, listing: parsed.ok ? parsed.listing : null });
  }
  run.counts.items += sightings.size;

  const existing = await getSeenItems(deps.pool, [...sightings.keys()]);
  const firstSightings = [...sightings.values()].filter((s) => !existing.has(s.key.itemKey));
  run.counts.newItems += firstSightings.length;

  // A listing's limit is the one at its first sighting (spec 6.4).
  const firstSeen = (itemKey: string): Date => existing.get(itemKey)?.firstSeenAt ?? ctx.now;
  const oldest = Math.min(ctx.now.getTime(), ...[...existing.values()].map((state) => state.firstSeenAt.getTime()));
  const values = await okMarketValuesBetween(
    deps.pool,
    ctx.products.map((product) => product.id),
    new Date(oldest - MARKET_VALUE_MAX_AGE_MS),
    ctx.now,
  );

  const seen: SeenItemSighting[] = [];
  const prices: PriceSampleRow[] = [];
  const samples: ClassifierSampleRow[] = [];
  const toCandidates: NewCandidate[] = [];
  // Candidates per product this Berlin day: committed ones (earlier pages and runs included), plus
  // the ones this page makes.
  const today = new Map<string, number>();
  for (const sighting of sightings.values()) {
    const { key, listing } = sighting;
    const before = existing.get(key.itemKey);
    const resolved = resolveProducts(ctx.products, values, firstSeen(key.itemKey), ctx.now);
    const match = listing
      ? matchListing(listing, resolved.map((r) => r.match), { lowFeedbackBelow: ctx.lowFeedbackBelow })
      : NOT_EUR;
    if (match.ambiguous) run.counts.ambiguous += 1;
    const chosen = resolved.find((r) => r.product.key === match.productKey);
    const productKey = chosen?.product.key ?? null;
    const candidatesToday = productKey
      ? (today.get(productKey) ?? (await countCandidatesSince(deps.pool, productKey, startOfBerlinDay(ctx.now))))
      : 0;
    const decision = decideSighting({
      source: ctx.source,
      existing: before ? { outcome: before.outcome, isCandidate: before.candidateAt !== null, productKey: before.segment } : null,
      itemCreationAt: listing?.itemCreationAt ?? null,
      now: ctx.now,
      match: { outcome: match.outcome, productKey },
      product: chosen
        ? { status: chosen.product.rules.status, watchFrom: chosen.product.watchFrom, candidateCapPerDay: chosen.product.rules.candidateCapPerDay }
        : null,
      candidatesToday,
    });
    if (productKey) today.set(productKey, candidatesToday + (decision.makeCandidate ? 1 : 0));
    seen.push({ ...key, feedId: ctx.feedId, segment: productKey, outcome: decision.outcome, seenAt: ctx.now });
    if (decision.priceSample && productKey && listing) {
      prices.push({
        segment: productKey,
        feedId: ctx.feedId,
        priceCents: listing.priceCents,
        shippingCents: listing.shippingCents,
        landedCents: listing.landedCents,
        totalGb: match.unitTotal,
        seenAt: ctx.now,
      });
    }
    // The classifier review reads first sightings; a later sighting repeats the same decision.
    if (!before) {
      samples.push({
        feedId: ctx.feedId,
        segment: productKey,
        title: sighting.summary.title ?? "",
        landedCents: listing?.landedCents ?? null,
        outcome: match.outcome === "candidate" ? "candidate" : "rejected",
        reason: match.outcome === "candidate" ? null : match.outcome,
        seenAt: ctx.now,
      });
    }
    const limit = match.conditionGroup === null ? undefined : chosen?.limits.get(match.conditionGroup);
    if (decision.makeCandidate && chosen && listing && match.conditionGroup && limit) {
      toCandidates.push({
        ...sighting,
        listing,
        product: chosen.product,
        match,
        firstSeenAt: firstSeen(key.itemKey),
        productFields: {
          productVersion: chosen.product.version,
          matchVersion: chosen.product.matchVersion,
          conditionGroup: match.conditionGroup,
          limitCents: limit.limitCents,
          priceMode: limit.priceMode,
          marketValueId: limit.marketValue?.id ?? null,
        },
      });
    }
  }

  await inTransaction(deps.pool, async (client) => {
    // Rows are locked in key order, so a poll and a sweep on the same items never deadlock.
    await upsertSeenItems(client, [...seen].sort((a, b) => (a.itemKey < b.itemKey ? -1 : 1)));
    await insertPriceSamples(client, prices);
    await insertClassifierSamples(client, samples);
    await confirmListings(client, [...existing.keys()], ctx.now);
  });

  for (const candidate of toCandidates) {
    const listingId = await createCandidate(deps, candidate, ctx);
    // null: another run made the item a candidate first (candidate once).
    if (listingId === null) continue;
    run.counts.candidates += 1;
    deps.log.info({ event: "candidate_created", listing_id: listingId, segment: candidate.product.key, source: ctx.source });
  }
  return { allUnseen: firstSightings.length === sightings.size };
}

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
// no row. rule_version holds the product version the candidate passed.
async function createCandidate(deps: SearchDeps, candidate: NewCandidate, ctx: PageContext): Promise<string | null> {
  const { key, summary, listing, product, match } = candidate;
  return inTransaction(deps.pool, async (client) => {
    if (!(await claimCandidate(client, key.itemKey, ctx.now))) return null;
    const listingId = await insertListing(client, {
      ...key,
      itemId: listing.itemId,
      legacyItemId: listing.legacyItemId,
      feedId: ctx.feedId,
      segment: product.key,
      firstSeenAt: candidate.firstSeenAt,
      itemCreationAt: listing.itemCreationAt,
      itemEndAt: listing.itemEndAt,
      contentExpiresAt: listing.contentExpiresAt,
    });
    await upsertListingContent(client, listingId, summaryContent(summary, listing));
    await insertCandidate(client, {
      itemKey: key.itemKey,
      listingId,
      feedId: ctx.feedId,
      segment: product.key,
      source: ctx.source,
      priceCents: listing.priceCents,
      shippingCents: listing.shippingCents,
      landedCents: listing.landedCents,
      shippingKnown: listing.shippingKnown,
      totalGb: match.unitTotal,
      ruleVersion: product.version,
      flags: match.flags,
      createdAt: ctx.now,
      ...candidate.productFields,
    });
    await deps.queue.send("enrich", { listingId }, { db: client });
    return listingId;
  });
}

// Spec 9: the products a search serves, as they are now. Archived or draft products have left
// the search with the save that changed them.
const isPolled = (product: StoredProduct): boolean => product.rules.status === "active" || product.rules.status === "paused";

// Spec 5.1, 5.5: one poll of a search, sort=newlyListed, its price filter. Page 2 and 3 follow
// only while every item of the page before was unseen, within the search's daily overflow pages.
export function createPollHandler(deps: SearchDeps): JobHandler<"poll"> {
  return async ({ searchId }, job) => {
    const now = deps.clock.now();
    const [search, products, resolved] = await Promise.all([
      loadSearch(deps.pool, searchId),
      listProducts(deps.pool),
      loadSettings(deps.pool, deps.settingsEnv),
    ]);
    const members = products.filter((product) => search?.productIds.includes(product.id) === true && isPolled(product));
    const pollable = search && search.enabled && !search.retired && members.length > 0 ? search : null;
    const start: PollRunStart = { kind: "poll", feedId: searchId, baseline: false, startedAt: now };
    const ctx: PageContext = {
      feedId: searchId,
      source: "poll",
      products: members,
      lowFeedbackBelow: resolved.settings.lowFeedbackBelow,
      now,
    };
    await trackRun(
      deps,
      start,
      { signal: job.signal, logFields: { search: searchId, kind: "poll" } },
      pollable && ((run) => readPages(deps, run, pollable, ctx)),
    );
  };
}

async function readPages(deps: SearchDeps, run: SearchRun, search: SearchRow, ctx: PageContext): Promise<void> {
  const overflowUsed = await overflowPagesSince(deps.pool, search.id, startOfBerlinDay(ctx.now));
  for (let page = 1; ; page += 1) {
    const request = buildFeedSearch({
      q: search.q,
      categoryId: search.categoryId,
      conditionIds: search.conditionIds,
      price: { floorEur: search.floorEur, ceilingEur: search.ceilingEur },
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
      baseline: false,
      overflowPagesUsedToday: overflowUsed + page - 1,
      overflowPagesPerDay: OVERFLOW_PAGES_PER_SEARCH,
    });
    if (next.capReached) run.counts.capReached = true;
    if (!next.fetchNext) return;
  }
}

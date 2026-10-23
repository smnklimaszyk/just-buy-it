import {
  listProducts,
  loadMarketPool,
  storeMarketValues,
  takeExtraSnapshotSlot,
  upsertMarketListings,
  wrongProductItemKeys,
  type DbPool,
  type MarketSighting,
  type Queryable,
  type StoredProduct,
} from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import {
  computeMarketValue,
  CONDITION_GROUPS,
  listingWeight,
  matchListing,
  MAX_SNAPSHOT_PAGES,
  searchQuery,
  SNAPSHOT_PAGE_SIZE,
  toListingCandidate,
  UNREAD_WEIGHT_SHARE_LIMIT,
  unreadWeightShare,
  type Clock,
  type ConditionGroup,
  type MatchProduct,
} from "@ebay-sniper/domain";
import {
  buildMarketSearch,
  EbayError,
  type BrowseSearchPage,
  type BrowseSearchRequest,
  type ItemSummary,
  type ReserveEbayCall,
} from "@ebay-sniper/ebay";
import type { ItemKeyFn } from "../item-key.js";
import { conditionGroups, inTransaction, type BrowseSearch, type LogFn } from "./poll.js";

export type MarketSnapshotDeps = {
  pool: DbPool;
  clock: Clock;
  reserve: ReserveEbayCall;
  createSearch: (reserve: ReserveEbayCall) => BrowseSearch;
  itemKey: ItemKeyFn;
  postalCode: string;
  log: { info: LogFn; warn: LogFn };
};

// What the pages of one snapshot gave. `capped`: it stopped at the page cap with more than 10 % of
// the weight unread (spec 6.2).
type Snapshot = { pages: number; total: number | null; items: ItemSummary[]; capped: boolean };

// Spec 6.3: page 1, then pages 2 and 3 only while eBay has more and the unread asks could carry
// more than 10 % of the weight. Newest first, so every unread ask is older than the oldest read.
async function readPages(
  deps: MarketSnapshotDeps,
  product: StoredProduct,
  snapshot: Snapshot,
  fetch: (request: BrowseSearchRequest) => Promise<BrowseSearchPage>,
): Promise<void> {
  const now = deps.clock.now();
  let readWeight = 0;
  let oldest: Date | null = null;
  for (let page = 1; page <= MAX_SNAPSHOT_PAGES; page += 1) {
    const result = await fetch(
      buildMarketSearch({
        q: searchQuery(product.rules.searchWords),
        categoryId: product.rules.categoryId,
        conditionIds: product.rules.conditionIds,
        ...(page === 1 ? {} : { offset: (page - 1) * SNAPSHOT_PAGE_SIZE }),
        postalCode: deps.postalCode,
      }),
    );
    snapshot.pages = page;
    snapshot.total = result.total;
    snapshot.items.push(...result.items);
    for (const summary of result.items) {
      const origin = originOf(summary);
      if (origin === null) continue;
      readWeight += listingWeight(origin, now);
      if (oldest === null || origin < oldest) oldest = origin;
    }
    const unread = result.total - page * SNAPSHOT_PAGE_SIZE;
    const worthReading =
      result.next !== undefined &&
      unread > 0 &&
      oldest !== null &&
      unreadWeightShare({ readWeight, unread, oldestReadOriginAt: oldest, at: now }) > UNREAD_WEIGHT_SHARE_LIMIT;
    if (!worthReading) return;
  }
  snapshot.capped = true;
}

// Spec 6.3: one snapshot of a product, its market listings and one market value per watched
// condition group. The payload names only the product: when the product has a request open or
// queued, the job serves it as an extra snapshot, whichever queued the job; otherwise it is the
// nightly snapshot.
export function createMarketSnapshotHandler(deps: MarketSnapshotDeps): JobHandler<"market-snapshot"> {
  return async ({ productId }, job) => {
    const now = deps.clock.now();
    const product = (await listProducts(deps.pool)).find((p) => p.id === productId);
    const request = await claimRequest(deps.pool, productId);
    const kind: SnapshotKind = request === null ? "nightly" : "extra";
    // Spec 9: a product archived, gone or without its eBay source since the job was queued.
    if (!product || product.rules.status === "archived" || !product.ebayEnabled) {
      if (request !== null) await endRequest(deps.pool, request, "refused", now);
      deps.log.info({ event: "market_snapshot_skipped", product_id: productId, kind });
      return;
    }
    const runId = await startRun(deps.pool, product.id, now);
    let calls = 0;
    const search = deps.createSearch(async (reservation) => {
      const answer = await deps.reserve(reservation);
      if (answer === "ok") calls += 1;
      return answer;
    });
    const snapshot: Snapshot = { pages: 0, total: null, items: [], capped: false };
    let status: RunEnd["status"];
    let errorKind: string | null = null;
    let thrown: unknown = null;
    try {
      if (kind === "extra" && !(await takeExtraSnapshotSlot(deps.pool, now))) {
        status = "quota_refused";
        errorKind = "daily_cap";
      } else {
        await readPages(deps, product, snapshot, (searchRequest) => {
          // A cached token would let an aborted job reserve a unit before fetch notices the abort.
          job.signal.throwIfAborted();
          return search(searchRequest, { callClass: "standard", purpose: PURPOSE[kind], minLeft: MIN_LEFT[kind], signal: job.signal });
        });
        status = await inTransaction(deps.pool, async (client) => {
          const stored = await storeSnapshot(client, deps, product, snapshot, now);
          await finishRun(client, runId, { status: stored, at: deps.clock.now(), calls, snapshot, errorKind: null });
          // A discarded snapshot served no request: the request waits for the next tick, which
          // snapshots the new rules (the save could not add one while this one was running).
          if (request !== null) await endRequest(client, request, stored === "ok" ? "done" : "open", deps.clock.now());
          return stored;
        });
      }
    } catch (error) {
      ({ status, errorKind } = failureOf(error, job.signal));
      thrown = error;
    }
    if (status === "quota_refused" || status === "error") {
      await endRun(deps, runId, request, { status, at: deps.clock.now(), calls, snapshot, errorKind });
    }
    deps.log.info({
      event: "market_snapshot",
      run_id: runId,
      product: product.key,
      kind,
      status,
      error_kind: errorKind,
      calls,
      pages: snapshot.pages,
      total: snapshot.total,
      capped: snapshot.capped,
    });
    // eBay failures and the deadline end the job (the next request or night is the retry);
    // anything else is thrown.
    if (thrown !== null && !(thrown instanceof EbayError) && errorKind !== "deadline") throw thrown;
  };
}

type SnapshotKind = "nightly" | "extra";

// Spec 5.4: the nightly snapshot stops at 3,000 used units; an extra snapshot (created, rules
// changed, check now) at 2,500, so polls and the nightly run keep what they need.
const MIN_LEFT: Record<SnapshotKind, number> = { nightly: 2000, extra: 2500 };
const PURPOSE: Record<SnapshotKind, string> = { nightly: "market_nightly", extra: "market_extra" };

type ClaimedRequest = { id: string };

// The product's request, open or queued, now running. One per product (the partial unique index).
async function claimRequest(db: Queryable, productId: string): Promise<ClaimedRequest | null> {
  const result = await db.query<{ id: string }>(
    `UPDATE app.market_request SET status = 'running'
      WHERE product_id = $1 AND status IN ('open', 'queued') RETURNING id`,
    [productId],
  );
  return result.rows[0] ?? null;
}

async function endRequest(db: Queryable, request: ClaimedRequest, status: "done" | "refused" | "open", at: Date): Promise<void> {
  await db.query("UPDATE app.market_request SET status = $2, done_at = $3 WHERE id = $1", [
    request.id,
    status,
    status === "open" ? null : at,
  ]);
}

// A run that stored nothing: its request is refused, and the next request or night tries again.
async function endRun(deps: MarketSnapshotDeps, runId: string, request: ClaimedRequest | null, end: RunEnd): Promise<void> {
  await finishRun(deps.pool, runId, end);
  if (request !== null) await endRequest(deps.pool, request, "refused", end.at);
}

function failureOf(error: unknown, signal: AbortSignal): { status: "error" | "quota_refused"; errorKind: string | null } {
  if (signal.aborted) return { status: "error", errorKind: "deadline" };
  if (error instanceof EbayError) {
    return error.kind === "quota_refused" ? { status: "quota_refused", errorKind: null } : { status: "error", errorKind: error.kind };
  }
  return { status: "error", errorKind: "db" };
}

// One row of ebay_live.market_preview: every title of the newest snapshot with what the rules
// said, for the "which listings counted" list (spec 6.5, 6.6). Kept 6 hours.
type PreviewRow = {
  itemKey: string;
  legacyItemId: string;
  title: string;
  landedCents: number | null;
  conditionGroup: ConditionGroup | null;
  outcome: string;
};

type Classified = { preview: PreviewRow; sighting: MarketSighting | null };

// The matcher at any price: steps 1 to 6 of spec 3.4 decide, the band never does.
function anyPrice(product: StoredProduct): MatchProduct {
  const open = { limitCents: Number.MAX_SAFE_INTEGER, floorCents: 0 };
  return { key: product.key, ...product.rules, limits: Object.fromEntries(CONDITION_GROUPS.map((group) => [group, open])) };
}

const originOf = (summary: ItemSummary): Date | null => {
  const date = summary.itemOriginDate ?? summary.itemCreationDate;
  return date === undefined ? null : new Date(date);
};

// Spec 6.1: an ask counts when it passes the product's own rules and its landed price is known. A
// matching ask without a shipping cost is kept as excluded, so the value's counts show it.
function classify(deps: MarketSnapshotDeps, product: StoredProduct, match: MatchProduct, summary: ItemSummary, now: Date): Classified | null {
  const parsed = toListingCandidate(summary, now);
  if (!parsed.ok || summary.legacyItemId === undefined) return null;
  const { listing } = parsed;
  const result = matchListing(listing, [match], { lowFeedbackBelow: 0 });
  const itemKey = deps.itemKey(summary.legacyItemId).itemKey;
  const qualifies = result.outcome === "candidate" && result.conditionGroup !== null;
  const outcome = !qualifies ? result.outcome : listing.landedCents === null ? "unknown_shipping" : "match";
  const preview: PreviewRow = {
    itemKey,
    legacyItemId: listing.legacyItemId,
    title: listing.title,
    landedCents: listing.landedCents,
    conditionGroup: result.conditionGroup,
    outcome,
  };
  if (!qualifies) return { preview, sighting: null };
  return {
    preview,
    sighting: {
      source: "ebay",
      itemKey,
      conditionGroup: result.conditionGroup,
      matchVersion: product.matchVersion,
      landedCents: listing.landedCents ?? listing.priceCents,
      unitTotal: result.unitTotal,
      originAt: originOf(summary),
      seenAt: now,
      bestOffer: listing.buyingOptions.includes("BEST_OFFER"),
      excludedReason: listing.landedCents === null ? "unknown_shipping" : null,
    },
  };
}

async function replacePreview(db: Queryable, productId: string, rows: readonly PreviewRow[], seenAt: Date): Promise<void> {
  await db.query("DELETE FROM ebay_live.market_preview WHERE product_id = $1", [productId]);
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO ebay_live.market_preview (product_id, item_key, legacy_item_id, title, landed_cents, condition_group, outcome, seen_at)
     SELECT $1::uuid, u.*, $8::timestamptz
       FROM unnest($2::text[], $3::text[], $4::text[], $5::integer[], $6::text[], $7::text[]) AS u(k, l, t, c, g, o)`,
    [
      productId,
      rows.map((r) => r.itemKey),
      rows.map((r) => r.legacyItemId),
      rows.map((r) => r.title),
      rows.map((r) => r.landedCents),
      rows.map((r) => r.conditionGroup),
      rows.map((r) => r.outcome),
      seenAt,
    ],
  );
}

// Spec 6.3: the snapshot is stored only for the rules that chose its listings. The product row is
// read again with a share lock, so a save that bumps match_version either committed before this
// read (the snapshot is discarded) or waits until this transaction ends.
async function storeSnapshot(
  client: Queryable,
  deps: MarketSnapshotDeps,
  product: StoredProduct,
  snapshot: Snapshot,
  now: Date,
): Promise<"ok" | "discarded"> {
  const current = await client.query<{ match_version: number }>(
    "SELECT match_version FROM app.product WHERE id = $1 FOR SHARE",
    [product.id],
  );
  if (current.rows[0]?.match_version !== product.matchVersion) return "discarded";
  const match = anyPrice(product);
  const byKey = new Map<string, Classified>();
  for (const summary of snapshot.items) {
    const classified = classify(deps, product, match, summary, now);
    if (classified && !byKey.has(classified.preview.itemKey)) byKey.set(classified.preview.itemKey, classified);
  }
  const classified = [...byKey.values()];
  await upsertMarketListings(
    client,
    product.id,
    classified.flatMap((c) => (c.sighting ? [c.sighting] : [])),
  );
  await replacePreview(client, product.id, classified.map((c) => c.preview), now);
  const pool = await loadMarketPool(client, product.id, now);
  const wrong = await wrongProductItemKeys(client, product.id);
  const results = conditionGroups(product).map((conditionGroup) =>
    computeMarketValue(pool, {
      conditionGroup,
      matchVersion: product.matchVersion,
      source: "ebay",
      perGb: product.rules.perGb,
      capped: snapshot.capped,
      wrongProductItemKeys: wrong,
      at: now,
    }),
  );
  const stored = await storeMarketValues(client, product.id, results);
  if (product.rules.categoryName === null) await nameCategory(client, product, snapshot.items);
  return stored.ok ? "ok" : "discarded";
}

// Spec 2.1: category_name comes from "Suggest category" or the newest snapshot. A name the
// product already has is kept.
async function nameCategory(db: Queryable, product: StoredProduct, items: readonly ItemSummary[]): Promise<void> {
  const name = items
    .flatMap((item) => item.categories ?? [])
    .find((category) => category.categoryId === product.rules.categoryId && category.categoryName !== undefined)?.categoryName;
  if (name === undefined) return;
  await db.query("UPDATE app.product SET category_name = $2 WHERE id = $1 AND category_name IS NULL", [product.id, name]);
}

async function startRun(db: Queryable, productId: string, at: Date): Promise<string> {
  const result = await db.query<{ id: string }>(
    "INSERT INTO app.market_run (product_id, started_at) VALUES ($1, $2) RETURNING id",
    [productId, at],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error("market_run insert returned no id");
  return id;
}

type RunEnd = {
  status: "ok" | "error" | "quota_refused" | "discarded";
  at: Date;
  calls: number;
  snapshot: Snapshot;
  errorKind: string | null;
};

async function finishRun(db: Queryable, runId: string, end: RunEnd): Promise<void> {
  await db.query(
    `UPDATE app.market_run SET status = $2, finished_at = $3, calls = $4, pages = $5, total = $6, error_kind = $7
      WHERE id = $1`,
    [runId, end.status, end.at, end.calls, end.snapshot.pages, end.snapshot.total, end.errorKind],
  );
}

import { DAY_END_HOUR, DAY_START_HOUR } from "./budget.js";
import { isTooOldAtFirstSighting } from "./listing.js";
import type { MatchOutcome, MatchReason } from "./match/match.js";
import type { ProductStatus } from "./product.js";
import {
  breakerPauseUntil,
  DUE_SLACK_MS,
  effectiveRunStatus,
  SWEEP_MIN_GAP_MS,
  type PollDecision,
  type RunRow,
} from "./schedule.js";
import { berlinWallTime } from "./time.js";

// Spec 5.5 rules of a poll or sweep, pure.

// Spec 2.3: search ids are "s" and a number from app.search_id_seq (the app.search check).
const SEARCH_ID = /^s[1-9][0-9]{0,17}$/;

// The poll payload carries a search id (spec 9).
export const isSearchId = (value: unknown): value is string => typeof value === "string" && SEARCH_ID.test(value);

// Spec 2.1: the app.product key check.
const PRODUCT_KEY = /^[a-z][a-z0-9_]{1,39}$/;

// The sweep payload carries a product key (spec 9).
export const isProductKey = (value: unknown): value is string => typeof value === "string" && PRODUCT_KEY.test(value);

// app.seen_item.outcome. No prices.
export type SeenOutcome = "candidate" | "baseline" | "too_old" | "over_cap" | "product_paused" | MatchReason;

// The matched product's fields the decision reads.
export type SightingProduct = { status: ProductStatus; watchFrom: Date | null; candidateCapPerDay: number };

export type SightingInput = {
  source: "poll" | "sweep";
  // The item's seen_item row before this sighting, or null at the first sighting. Rows Release 0
  // wrote may hold outcomes v2 does not know, so the outcome is any code. productKey is the
  // product that sighting was named for (seen_item.segment).
  existing: { outcome: string; isCandidate: boolean; productKey: string | null } | null;
  itemCreationAt: Date | null;
  now: Date;
  // matchListing's outcome and the product it names (null before its must words matched).
  match: { outcome: MatchOutcome; productKey: string | null };
  // The product of match.productKey, or null when none is named.
  product: SightingProduct | null;
  // Candidates of that product so far this Berlin day.
  candidatesToday: number;
};

export type SightingDecision = { outcome: string; makeCandidate: boolean; priceSample: boolean };

// Steps 1 to 6 of spec 3.4 passed, at any price: the listing qualifies for the price read.
const QUALIFYING: ReadonlySet<MatchOutcome> = new Set(["candidate", "below_floor", "above_max"]);

// too_old items never become candidates later, and a baseline never for the product it was
// recorded for: item keys are global, so another product's watch_from decides for that product.
// A rejected or over-cap item may, when a later sighting is in band; a candidate never again (one
// alert per item, Q6).
const stuck = (existing: NonNullable<SightingInput["existing"]>, productKey: string | null): boolean =>
  existing.outcome === "too_old" || (existing.outcome === "baseline" && existing.productKey === productKey);

export function decideSighting(s: SightingInput): SightingDecision {
  const priceSample = s.existing === null && s.source === "poll" && QUALIFYING.has(s.match.outcome);
  const no = (outcome: string): SightingDecision => ({ outcome, makeCandidate: false, priceSample });
  if (s.existing?.isCandidate) return no(s.existing.outcome);
  if (s.existing && stuck(s.existing, s.match.productKey)) return no(s.existing.outcome);
  // Spec 5.5: a listing of the named product created before its watch_from is a sticky baseline,
  // whatever its outcome, so it never alerts; nothing is written back to the product.
  if (s.product && listedBeforeWatchFrom(s.itemCreationAt, s.product.watchFrom, s.now)) return no("baseline");
  if (s.existing === null && isTooOldAtFirstSighting(s.itemCreationAt, s.now)) return no("too_old");
  if (s.match.outcome !== "candidate" || s.product === null) return no(s.match.outcome);
  // Spec 9: a paused product records its sightings and makes no candidates; not sticky, so a
  // listing seen again after the resume still can.
  if (s.product.status !== "active") return no("product_paused");
  if (s.candidatesToday >= s.product.candidateCapPerDay) return no("over_cap");
  return { outcome: "candidate", makeCandidate: true, priceSample };
}

// Spec 9: a pending candidate whose product is no longer active when enrich or screen loads it
// ends expired with this reject reason; null while the product is active.
export function inactiveProductReason(status: ProductStatus): "product_paused" | "product_archived" | null {
  if (status === "active") return null;
  return status === "archived" ? "product_archived" : "product_paused";
}

// Spec 5.5: without a creation date a listing counts as listed before watch_from for the first
// 30 minutes after it, and as listed after it later.
export const UNDATED_BEFORE_WATCH_MS = 30 * 60 * 1000;

// Spec 5.5: a product never alerts on a listing created before its watch_from (set on the first
// activation and when its search words, category or conditions change). A product without one
// holds nothing back.
export function listedBeforeWatchFrom(itemCreationAt: Date | null, watchFrom: Date | null, now: Date): boolean {
  if (watchFrom === null) return false;
  if (itemCreationAt === null) return now.getTime() - watchFrom.getTime() <= UNDATED_BEFORE_WATCH_MS;
  return itemCreationAt.getTime() < watchFrom.getTime();
}

// The app.search fields the due rule reads.
export type PollSearch = { enabled: boolean; retired: boolean; dayIntervalS: number; nightIntervalS: number };

// Spec 9: poll-tick queues a search's poll when it is due.
export function searchPollDue(search: PollSearch, runsNewestFirst: readonly RunRow[], now: Date): PollDecision {
  if (!search.enabled || search.retired) return { due: false, reason: "paused" };
  const newest = runsNewestFirst[0];
  if (newest && effectiveRunStatus(newest, now) === "running") return { due: false, reason: "running" };
  const pauseUntil = breakerPauseUntil(runsNewestFirst, now);
  if (pauseUntil && pauseUntil.getTime() > now.getTime()) return { due: false, reason: "breaker" };
  const hour = berlinWallTime(now).hour;
  const intervalS = hour >= DAY_START_HOUR && hour < DAY_END_HOUR ? search.dayIntervalS : search.nightIntervalS;
  const waitMs = intervalS * 1000 - DUE_SLACK_MS;
  if (newest && now.getTime() - newest.startedAt.getTime() < waitMs) return { due: false, reason: "interval" };
  return { due: true };
}

// The product fields the sweep's due rule reads.
export type SweepProduct = { status: ProductStatus; ebayEnabled: boolean; priceDropCheck: boolean; sweepMinute: number };

export type ProductSweepDecision = { due: true } | { due: false; reason: "off" | "slot" | "running" | "interval" };

// Spec 5.1: the hourly price-sorted sweep of an active product with the price-drop check runs in
// its own minute. A paused product makes no candidates, so it is not swept. Berlin offsets are
// whole hours, so the UTC minute is the Berlin minute.
export function productSweepDue(product: SweepProduct, runsNewestFirst: readonly RunRow[], now: Date): ProductSweepDecision {
  if (product.status !== "active" || !product.ebayEnabled || !product.priceDropCheck) return { due: false, reason: "off" };
  if (now.getUTCMinutes() !== product.sweepMinute) return { due: false, reason: "slot" };
  const newest = runsNewestFirst[0];
  if (newest && effectiveRunStatus(newest, now) === "running") return { due: false, reason: "running" };
  if (newest && now.getTime() - newest.startedAt.getTime() < SWEEP_MIN_GAP_MS) return { due: false, reason: "interval" };
  return { due: true };
}

export const MAX_PAGES_PER_POLL = 3;

export type PageState = {
  // The page just fetched, 1-based.
  page: number;
  // Every item on it was unseen (no seen_item row before this poll).
  allUnseen: boolean;
  // eBay reported a next page.
  hasMore: boolean;
  baseline: boolean;
  // Pages beyond page 1 fetched by this feed's polls today (Berlin day), this poll included.
  overflowPagesUsedToday: number;
  overflowPagesPerDay: number;
};

// Page 2 only when every item on page 1 was unseen and this is not a baseline poll; page 3 the
// same. Page 3 still all unseen, or the daily overflow limit used up, sets poll_run.cap_reached.
export function nextPageDecision(s: PageState): { fetchNext: boolean; capReached: boolean } {
  if (s.baseline || !s.allUnseen || !s.hasMore) return { fetchNext: false, capReached: false };
  if (s.page >= MAX_PAGES_PER_POLL) return { fetchNext: false, capReached: true };
  if (s.overflowPagesUsedToday >= s.overflowPagesPerDay) return { fetchNext: false, capReached: true };
  return { fetchNext: true, capReached: false };
}

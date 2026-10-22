import { isQualifyingListing, type ClassifyResult, type RejectReason } from "./classify/classify.js";
import { isTooOldAtFirstSighting } from "./listing.js";

// Section 3.2 rules of a poll, pure.

// app.seen_item.outcome. No prices.
export type SeenOutcome = "candidate" | "baseline" | "too_old" | "over_cap" | "segment_off" | RejectReason;

export type SightingInput = {
  source: "poll" | "sweep";
  baseline: boolean;
  // The item's seen_item row before this sighting, or null at the first sighting.
  existing: { outcome: SeenOutcome; isCandidate: boolean } | null;
  itemCreationAt: Date | null;
  now: Date;
  classification: ClassifyResult;
  // Candidates of the classified segment so far this Berlin day.
  candidatesToday: number;
  candidateCapPerDay: number;
  // segment_rule.enabled of the classified segment: a disabled segment makes no candidates.
  segmentEnabled: boolean;
};

export type SightingDecision = { outcome: SeenOutcome; makeCandidate: boolean; priceSample: boolean };

// Baseline and too_old items never become candidates later. A rejected, over-cap or
// disabled-segment item may, when a later sighting is in band; a candidate never again (one alert
// per item, Q6). A baseline poll records 'baseline' only for items in band at that time; an item
// it rejects keeps the reason, so a later price drop into the band still alerts (section 3.2).
const STICKY: ReadonlySet<SeenOutcome> = new Set(["baseline", "too_old"]);

export function decideSighting(s: SightingInput): SightingDecision {
  const priceSample = s.existing === null && s.source === "poll" && isQualifyingListing(s.classification);
  const no = (outcome: SeenOutcome): SightingDecision => ({ outcome, makeCandidate: false, priceSample });
  if (s.existing?.isCandidate) return no(s.existing.outcome);
  if (s.baseline) {
    if (s.existing) return no(s.existing.outcome);
    return no(s.classification.outcome === "rejected" ? s.classification.reason : "baseline");
  }
  if (s.existing && STICKY.has(s.existing.outcome)) return no(s.existing.outcome);
  if (s.existing === null && isTooOldAtFirstSighting(s.itemCreationAt, s.now)) return no("too_old");
  if (s.classification.outcome === "rejected") return no(s.classification.reason);
  if (!s.segmentEnabled) return no("segment_off");
  if (s.candidatesToday >= s.candidateCapPerDay) return no("over_cap");
  return { outcome: "candidate", makeCandidate: true, priceSample };
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

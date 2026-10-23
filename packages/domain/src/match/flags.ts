import type { ConditionGroup } from "./condition-groups.js";
import { entryHits, parseEntry, type Entry } from "./entries.js";

// Kept on the candidate, passed to Claude and shown in the email, in this order, followed by
// one `warn:<entry>` per warn word of the product that matched.
export const MATCH_LISTING_FLAGS = [
  "untested",
  "pickup_only",
  "shipping_unknown",
  "financing",
  "open_box_or_refurbished",
  "low_feedback",
  "best_offer",
] as const;
export type MatchListingFlag = (typeof MATCH_LISTING_FLAGS)[number];
export type WarnFlag = `warn:${string}`;
export type MatchFlag = MatchListingFlag | WarnFlag;

const words = (list: readonly string[]) => list.map(parseEntry);
const UNTESTED = words(["ungetestet", "untested", "nicht getestet"]);
const PICKUP = words(["abholung*", "pickup only"]);
const FINANCING = words(["finanzierung*", "ratenkauf*", "raten"]);

const anyHit = (tokens: readonly string[], entries: readonly Entry[]) =>
  entries.some((entry) => entryHits(tokens, entry).length > 0);

export type FlagInput = {
  titleTokens: readonly string[];
  shippingKnown: boolean;
  conditionGroup: ConditionGroup | null;
  feedbackScore: number | null;
  buyingOptions: readonly string[];
  warnWords: readonly string[];
  lowFeedbackBelow: number;
};

export function listingFlags(input: FlagInput): MatchFlag[] {
  const tokens = input.titleTokens;
  const on: Record<MatchListingFlag, boolean> = {
    untested: anyHit(tokens, UNTESTED),
    pickup_only: anyHit(tokens, PICKUP),
    shipping_unknown: !input.shippingKnown,
    financing: anyHit(tokens, FINANCING),
    open_box_or_refurbished: input.conditionGroup === "open_box" || input.conditionGroup === "refurbished",
    low_feedback: input.feedbackScore !== null && input.feedbackScore < input.lowFeedbackBelow,
    best_offer: input.buyingOptions.includes("BEST_OFFER"),
  };
  const warn = input.warnWords
    .map(parseEntry)
    .filter((entry) => entryHits(tokens, entry).length > 0)
    .map((entry): WarnFlag => `warn:${entry.text}`);
  return [...MATCH_LISTING_FLAGS.filter((flag) => on[flag]), ...warn];
}

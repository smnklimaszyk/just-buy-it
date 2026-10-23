import { berlinDay, formatBerlinTime } from "@ebay-sniper/domain";

// Spec 8.1: how the product pages write money, times and outcomes.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// "12 Sep 2026", the Berlin calendar date.
export function formatDay(at: Date): string {
  const [year, month, day] = berlinDay(at).split("-").map(Number);
  return `${String(day)} ${MONTHS[(month ?? 1) - 1] ?? ""} ${String(year)}`;
}

export type OutcomeLabel = { label: string; rule: string };

// The matcher's outcomes (spec 3.4), the poll's own (baseline, too_old, over_cap) and the market
// snapshot's, as people read them. Codes come from the database, so an unknown one is shown as
// its words, never looked up anywhere else.
const OUTCOMES: Record<string, OutcomeLabel> = {
  candidate: { label: "Became a candidate", rule: "Matched" },
  match: { label: "Counted", rule: "Matched" },
  no_title: { label: "No title", rule: "Listing" },
  not_eur: { label: "Not priced in euros", rule: "Listing" },
  auction: { label: "Auction", rule: "Listing" },
  item_group: { label: "Listing with variants", rule: "Listing" },
  defective: { label: "For parts or not working", rule: "Junk rule" },
  wanted_ad: { label: "Wanted ad", rule: "Junk rule" },
  rental: { label: "Rental", rule: "Junk rule" },
  box_or_picture_only: { label: "Box or picture only", rule: "Junk rule" },
  bundle: { label: "Bundle", rule: "Junk rule" },
  wrong_condition: { label: "Condition not chosen", rule: "Condition" },
  missing_word: { label: "A must word is missing", rule: "Must contain" },
  excluded_word: { label: "Has a word you excluded", rule: "Must not contain" },
  accessory: { label: "Looks like an accessory", rule: "Accessory check" },
  multiple_items: { label: "Several items", rule: "Quantity" },
  capacity_unknown: { label: "Size not found", rule: "Price per GB" },
  too_small: { label: "Below the minimum size", rule: "Price per GB" },
  below_floor: { label: "Below the floor", rule: "Price" },
  above_max: { label: "Above your limit", rule: "Price" },
  unknown_shipping: { label: "Shipping cost unknown", rule: "Price" },
  baseline: { label: "Listed before you started watching", rule: "Watch start" },
  too_old: { label: "Too old", rule: "Watch start" },
  over_cap: { label: "Over the candidates per day", rule: "Candidates per day" },
};

export const outcomeLabel = (code: string): OutcomeLabel => OUTCOMES[code] ?? { label: code.replaceAll("_", " "), rule: "Other" };

// "22 Oct 2026, 04:10 CEST": market values always show when they were computed (eBay licence 8.1(c)).
export const formatStamp = (at: Date): string => `${formatDay(at)}, ${formatBerlinTime(at)}`;

// Relative under 7 days ("3 h ago"), then the Berlin date.
export function formatWhen(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  if (ms >= 7 * DAY_MS) return formatDay(at);
  if (ms < MINUTE_MS) return "just now";
  if (ms < HOUR_MS) return `${String(Math.floor(ms / MINUTE_MS))} min ago`;
  if (ms < DAY_MS) return `${String(Math.floor(ms / HOUR_MS))} h ago`;
  const days = Math.floor(ms / DAY_MS);
  return days === 1 ? "1 day ago" : `${String(days)} days ago`;
}

// "EUR 1,234", or "EUR 2.10" when there are cents (per-GB limits are rounded to EUR 0.10).
export function formatPrice(cents: number): string {
  const euros = Math.floor(cents / 100).toLocaleString("en-US");
  const rest = cents % 100;
  return rest === 0 ? `EUR ${euros}` : `EUR ${euros}.${String(rest).padStart(2, "0")}`;
}

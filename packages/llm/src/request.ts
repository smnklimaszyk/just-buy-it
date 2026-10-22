import {
  TRUNCATION_MARK,
  collapseWhitespace,
  maskContactData,
  removeHiddenCharacters,
  segmentInfo,
  type CodeSignal,
  type ListingFlag,
  type Segment,
  type SellerAccountType,
} from "@ebay-sniper/domain";
import { MAX_USER_MESSAGE_BYTES } from "./screening-config.v1.js";

// What the screen job knows about one listing: the candidate's prices, the listing content from
// getItem and the scan results. There is no field for the item ID, any URL or the seller's
// identity, so none of them can reach the request.
export type ScreeningListing = {
  segment: Segment;
  // getItem title.
  title: string;
  condition: string | null;
  conditionDescription: string | null;
  priceCents: number;
  // null while shipping to DE is unknown.
  shippingCents: number | null;
  // The owner's maximum landed price for this item (per-GB segments: per-GB max x total GB).
  ownerMaxCents: number;
  seller: { feedbackScore: number | null; feedbackPercent: number | null; accountType: SellerAccountType | null };
  returns: { accepted: boolean | null; periodDays: number | null };
  itemLocationCountry: string | null;
  itemCreationAt: Date | null;
  itemSpecifics: { name: string; value: string }[];
  imageCount: number;
  // The description as cleanDescription() returns it (listing_content.description_text).
  descriptionText: string | null;
  ruleFlags: ListingFlag[];
  codeSignals: CodeSignal[];
};

// The section 5.1 fields, as the model reads them.
export type ListingFields = {
  segment: Segment;
  segment_description: string;
  title: string;
  condition: string | null;
  condition_description: string | null;
  price_eur: number;
  shipping_eur: number | "unknown";
  landed_eur: number | "unknown";
  owner_max_eur: number;
  percent_of_max: number;
  seller: { feedback_score: number | null; feedback_percent: number | null; account_type: SellerAccountType | null };
  returns: { accepted: boolean | null; period_days: number | null };
  item_location_country: string | null;
  listing_age_hours: number | null;
  item_specifics: { name: string; value: string }[];
  image_count: number;
  description: string | null;
  rule_flags: string[];
  code_signals: string[];
};

export type InputFlag = "description_truncated" | "input_capped";

export type ScreeningRequest = {
  userMessage: string;
  // UTF-8 bytes of userMessage (screening.request_bytes).
  requestBytes: number;
  inputFlags: InputFlag[];
};

const HOUR_MS = 60 * 60 * 1000;
const euros = (cents: number): number => cents / 100;

export const MAX_CONDITION_DESCRIPTION_CHARS = 1000;
export const MAX_ITEM_SPECIFICS = 30;
export const MAX_SPECIFIC_NAME_CHARS = 40;
export const MAX_SPECIFIC_VALUE_CHARS = 100;

// Every seller text goes through the same cleaning before it is sent: zero-width and bidi
// characters removed, whitespace collapsed, contact data masked. Masking runs before any cut, so a
// cut never leaves part of a phone number. The description arrives cleaned already; cleaning it
// again changes nothing but makes the masking hold whatever the caller passed.
function clean(text: string): string {
  return maskContactData(collapseWhitespace(removeHiddenCharacters(text)));
}

// Cuts to a number of code points, so no surrogate pair is split.
function cut(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join("");
}

export function toListingFields(listing: ScreeningListing, now: Date): ListingFields {
  const shipping = listing.shippingCents;
  // With shipping unknown the item price alone is compared, as in the price rules.
  const basisCents = shipping === null ? listing.priceCents : listing.priceCents + shipping;
  return {
    segment: listing.segment,
    segment_description: segmentInfo(listing.segment).description,
    title: clean(listing.title),
    condition: listing.condition === null ? null : clean(listing.condition),
    condition_description:
      listing.conditionDescription === null
        ? null
        : cut(clean(listing.conditionDescription), MAX_CONDITION_DESCRIPTION_CHARS),
    price_eur: euros(listing.priceCents),
    shipping_eur: shipping === null ? "unknown" : euros(shipping),
    landed_eur: shipping === null ? "unknown" : euros(basisCents),
    owner_max_eur: euros(listing.ownerMaxCents),
    percent_of_max: Math.round((basisCents / listing.ownerMaxCents) * 100),
    seller: {
      feedback_score: listing.seller.feedbackScore,
      feedback_percent: listing.seller.feedbackPercent,
      account_type: listing.seller.accountType,
    },
    returns: { accepted: listing.returns.accepted, period_days: listing.returns.periodDays },
    item_location_country: listing.itemLocationCountry,
    listing_age_hours:
      listing.itemCreationAt === null
        ? null
        : Math.max(0, Math.floor((now.getTime() - listing.itemCreationAt.getTime()) / HOUR_MS)),
    item_specifics: listing.itemSpecifics.slice(0, MAX_ITEM_SPECIFICS).map(({ name, value }) => ({
      name: cut(clean(name), MAX_SPECIFIC_NAME_CHARS),
      value: cut(clean(value), MAX_SPECIFIC_VALUE_CHARS),
    })),
    image_count: listing.imageCount,
    description: listing.descriptionText === null ? null : clean(listing.descriptionText),
    rule_flags: [...listing.ruleFlags],
    code_signals: [...listing.codeSignals],
  };
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

// "<" is written as its JSON escape, so seller text (decoded entities included) can never close or
// open the listing tags. The JSON still parses to the same text.
function render(fields: ListingFields): string {
  return `<listing>\n${JSON.stringify(fields, null, 2).replaceAll("<", "\\u003c")}\n</listing>`;
}

const fits = (message: string): boolean => byteLength(message) <= MAX_USER_MESSAGE_BYTES;

// Keeps `kept` code points, three quarters from the start and one quarter from the end, the same
// split as the head-and-tail cut of cleanDescription().
function cutMiddle(chars: string[], kept: number): string {
  const head = Math.ceil((kept * 3) / 4);
  const tail = kept - head;
  return `${chars.slice(0, head).join("")} ${TRUNCATION_MARK} ${tail === 0 ? "" : chars.slice(chars.length - tail).join("")}`.trim();
}

export type RenderedMessage = { userMessage: string; fields: ListingFields; inputCapped: boolean };

// The message grows with every kept unit (code point or item specific), so the most that fits
// below `total` is found by bisection. null when not even 0 kept fits.
function longestFitting(total: number, withKept: (kept: number) => ListingFields): RenderedMessage | null {
  let low = 0;
  let high = total - 1;
  let best: RenderedMessage | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const fields = withKept(mid);
    const userMessage = render(fields);
    if (fits(userMessage)) {
      best = { userMessage, fields, inputCapped: true };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

// Section 5.1 byte cap: over 12,000 bytes, the description is cut further from the middle, then
// item specifics are dropped from the end, until the message fits. Every call's input cost is
// bounded by the cap (section 5.5).
export function renderUserMessage(fields: ListingFields): RenderedMessage {
  const full = render(fields);
  if (fits(full)) return { userMessage: full, fields, inputCapped: false };
  let rest = fields;
  if (fields.description !== null) {
    const chars = [...fields.description];
    const withKept = (kept: number): ListingFields => ({ ...fields, description: cutMiddle(chars, kept) });
    const cut = longestFitting(chars.length, withKept);
    if (cut !== null) return cut;
    rest = withKept(0);
  }
  const specifics = rest.item_specifics;
  const dropped = longestFitting(specifics.length, (kept) => ({ ...rest, item_specifics: specifics.slice(0, kept) }));
  if (dropped !== null) return dropped;
  // Unreachable with eBay's title length: the other fields are cut to size in toListingFields.
  throw new Error("listing does not fit the input cap");
}

export function buildScreeningRequest(listing: ScreeningListing, now: Date): ScreeningRequest {
  const { userMessage, fields, inputCapped } = renderUserMessage(toListingFields(listing, now));
  const inputFlags: InputFlag[] = [];
  // Cut by cleanDescription() or by the byte cap.
  if (fields.description?.includes(TRUNCATION_MARK)) inputFlags.push("description_truncated");
  if (inputCapped) inputFlags.push("input_capped");
  return { userMessage, requestBytes: byteLength(userMessage), inputFlags };
}

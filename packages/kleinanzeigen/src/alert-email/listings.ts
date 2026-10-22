import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";
import { parsePrice, type KleinanzeigenPrice } from "./price.js";
import { cleanText, type HiddenCharacterKind } from "./text.js";

export const MAX_LISTINGS = 50;
export const MAX_TITLE_CHARS = 200;
const MAX_PRICE_TEXT_CHARS = 40;
const MAX_BLOCK_TEXTS = 6;

export type SellerType = "private" | "not_stated";

export type KleinanzeigenListing = {
  adId: string;
  url: string;
  title: string;
  titleTruncated: boolean;
  titleHadHiddenCharacters: boolean;
  titleHiddenCharacterKinds: HiddenCharacterKind[];
  price: KleinanzeigenPrice;
  priceText: string;
  sellerType: SellerType;
  thumbnailUrl: string | null;
};

export type ListingsRejectDetail =
  | "html_parse_failed"
  | "no_saved_search_link"
  | "listing_link_shape"
  | "saved_search_id_mismatch"
  | "listing_without_title"
  | "unexpected_block_shape"
  | "too_many_listings";

export type ExtractedListings =
  | { ok: true; savedSearchId: string; listings: KleinanzeigenListing[] }
  | { ok: false; reason: "malformed"; detail: ListingsRejectDetail }
  | { ok: false; reason: "no_listings"; detail: "no_listing_links" };

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

// The document flattened to what a reader sees, in order. Text inside a link is not a text event:
// the link carries it.
type Event = { kind: "text"; text: string } | { kind: "img"; src: string } | { kind: "link"; href: string };

// A <template> needs no entry: parse5 keeps its children in `content`, which the walk never visits.
const SKIPPED_ELEMENTS = new Set(["head", "style", "script"]);

function attribute(element: Element, name: string): string {
  return element.attrs.find((attr) => attr.name === name)?.value ?? "";
}

// Iterative, so deeply nested markup cannot overflow the call stack.
function documentEvents(html: string): Event[] {
  const events: Event[] = [];
  const stack: { node: Node; inLink: boolean }[] = [{ node: parse(html), inLink: false }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { node, inLink } = next;
    if (defaultTreeAdapter.isTextNode(node)) {
      // A node of hidden characters only still counts: dropping it would shift the price into the
      // title and lose the hidden-character signal.
      const cleaned = cleanText(node.value, node.value.length);
      if (!inLink && (cleaned.text !== "" || cleaned.hadHiddenCharacters)) events.push({ kind: "text", text: node.value });
      continue;
    }
    let childInLink = inLink;
    if (defaultTreeAdapter.isElementNode(node)) {
      if (SKIPPED_ELEMENTS.has(node.tagName)) continue;
      if (node.tagName === "a") {
        events.push({ kind: "link", href: attribute(node, "href") });
        childInLink = true;
      }
      if (node.tagName === "img") events.push({ kind: "img", src: attribute(node, "src") });
    }
    if (!("childNodes" in node)) continue;
    for (const child of [...node.childNodes].reverse()) stack.push({ node: child, inLink: childInLink });
  }
  return events;
}

function parseUrl(href: string): URL | null {
  try {
    return new URL(href);
  } catch {
    return null;
  }
}

function savedSearchIdOf(href: string): string | null {
  const url = parseUrl(href);
  if (url?.protocol !== "https:" || url.host !== "www.kleinanzeigen.de") return null;
  if (url.pathname !== "/m-suche-verwenden.html") return null;
  const id = url.searchParams.get("id") ?? "";
  return /^[0-9]{1,15}$/.test(id) ? id : null;
}

// null: not a listing link at all. A link into /s-anzeige/ in any other shape than the one we know
// means the layout changed, so the whole email is rejected rather than read half.
function listingLinkOf(href: string): { adId: string; savedSearchIds: string[] } | null | "bad_shape" {
  const url = parseUrl(href);
  if (url?.protocol !== "https:" || url.host !== "www.kleinanzeigen.de") return null;
  if (!url.pathname.startsWith("/s-anzeige/")) return null;
  const adId = /^\/s-anzeige\/([0-9]{6,15})$/.exec(url.pathname)?.[1];
  if (adId === undefined) return "bad_shape";
  return { adId, savedSearchIds: url.searchParams.getAll("sa") };
}

// Only https on img.kleinanzeigen.de itself, no user info, no port, and only when the src is
// already the URL parser's own form of itself. The URL parser forgives spaces, backslashes, case
// and missing slashes; a string that needed any of that is not passed on to a mail or a prompt.
function thumbnailOf(src: string | undefined): string | null {
  const url = parseUrl(src ?? "");
  if (url?.protocol !== "https:" || url.host !== "img.kleinanzeigen.de") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.href === src ? src : null;
}

function listingOf(adId: string, block: Event[]): KleinanzeigenListing | ListingsRejectDetail {
  const texts = block.flatMap((event) => (event.kind === "text" ? [event.text] : []));
  if (texts.length === 0) return "listing_without_title";
  // Today a block has three texts (title, price, badge); much more means a layout we do not know.
  if (texts.length > MAX_BLOCK_TEXTS) return "unexpected_block_shape";
  const title = cleanText(texts[0] ?? "", MAX_TITLE_CHARS);
  if (title.text === "") return "listing_without_title";
  const later = texts.slice(1).map((text) => cleanText(text, MAX_PRICE_TEXT_CHARS).text);
  const priceText = later.find((text) => parsePrice(text).kind !== "unknown") ?? later[0] ?? "";
  const firstImage = block.find((event) => event.kind === "img");
  return {
    adId,
    url: `https://www.kleinanzeigen.de/s-anzeige/${adId}`,
    title: title.text,
    titleTruncated: title.truncated,
    titleHadHiddenCharacters: title.hadHiddenCharacters,
    titleHiddenCharacterKinds: title.hiddenCharacterKinds,
    price: parsePrice(priceText),
    priceText,
    sellerType: later.includes("Von Privat") ? "private" : "not_stated",
    thumbnailUrl: thumbnailOf(firstImage?.kind === "img" ? firstImage.src : undefined),
  };
}

// Anchored on links and text only, never on class names or styles: the "Neue Treffer ansehen"
// link opens the list, and each "Anzeige ansehen" link closes the block of text before it.
export function extractListings(html: string): ExtractedListings {
  let events: Event[];
  try {
    events = documentEvents(html);
  } catch {
    return { ok: false, reason: "malformed", detail: "html_parse_failed" };
  }
  let savedSearchId: string | null = null;
  let start = events.length;
  for (const [index, event] of events.entries()) {
    savedSearchId = event.kind === "link" ? savedSearchIdOf(event.href) : null;
    if (savedSearchId !== null) {
      start = index + 1;
      break;
    }
  }
  if (savedSearchId === null) return { ok: false, reason: "malformed", detail: "no_saved_search_link" };
  const listings: KleinanzeigenListing[] = [];
  let block: Event[] = [];
  let previousAdId: string | null = null;
  for (const event of events.slice(start)) {
    const link = event.kind === "link" ? listingLinkOf(event.href) : null;
    if (link === null) {
      block.push(event);
      continue;
    }
    if (link === "bad_shape") return { ok: false, reason: "malformed", detail: "listing_link_shape" };
    if (link.savedSearchIds.some((id) => id !== savedSearchId)) {
      return { ok: false, reason: "malformed", detail: "saved_search_id_mismatch" };
    }
    // A second link to the same ad with no text since the first one belongs to that listing.
    const repeated = link.adId === previousAdId && !block.some((known) => known.kind === "text");
    previousAdId = link.adId;
    if (repeated) {
      block = [];
      continue;
    }
    const listing = listingOf(link.adId, block);
    if (typeof listing === "string") return { ok: false, reason: "malformed", detail: listing };
    if (!listings.some((known) => known.adId === listing.adId)) listings.push(listing);
    if (listings.length > MAX_LISTINGS) return { ok: false, reason: "malformed", detail: "too_many_listings" };
    block = [];
  }
  if (listings.length === 0) return { ok: false, reason: "no_listings", detail: "no_listing_links" };
  return { ok: true, savedSearchId, listings };
}

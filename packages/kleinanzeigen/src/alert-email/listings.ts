import { defaultTreeAdapter, Parser, type DefaultTreeAdapterMap, type TreeAdapter } from "parse5";
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
  | "html_too_complex"
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

// Some markup costs parse5 time that grows with the square of its size: a tag with tens of
// thousands of attributes, a long run of children moved by the adoption agency or foster parenting,
// text inside a table that parse5 replays at once. Rather than guard each shape, the parser gets the
// HTML in pieces and stops once it has taken too long. A real alert takes 3 to 5 ms of CPU time once
// warm; the first call in a fresh process takes 20 to 60 ms, one with 50 listings up to about 150
// ms. The limit is wall-clock time, which also counts time spent waiting for a CPU, so it leaves
// room for a host that is several times oversubscribed.
const MAX_PARSE_MS = 2_000;
const PARSE_CHUNK_CHARS = 1_024;

// Scope checks, the adoption agency and rebuilding formatting elements each scan the stack of open
// elements within a single step. A real alert nests about 30 deep.
const MAX_OPEN_ELEMENTS = 256;

// parse5 reopens every formatting element still listed in each new block, so a few bytes of input
// can add hundreds of elements; 34 KB can become a million. The tree and the walk after it stay
// small: a real alert makes about 3,700 insertions (most of them pieces of its style sheet text),
// one with 50 listings about 9,800.
const MAX_INSERTIONS = 30_000;

// Every copy of a reopened formatting element shares its attributes, and reading a link or an image
// looks through them. A real alert has at most 8 on one element.
const MAX_ATTRIBUTES = 64;

class HtmlTooComplex extends Error {}

// One piece can hold a single step that does a lot of work: parse5 replays all text buffered inside
// a table at once, and the adoption agency moves an element's children one at a time. So the
// deadline is also checked as the tree changes.
function limitedAdapter(checkDeadline: () => void): TreeAdapter<DefaultTreeAdapterMap> {
  let openElements = 0;
  let insertions = 0;
  const inserting = () => {
    insertions++;
    if (insertions > MAX_INSERTIONS) throw new HtmlTooComplex();
    checkDeadline();
  };
  return {
    ...defaultTreeAdapter,
    onItemPush() {
      openElements++;
      if (openElements > MAX_OPEN_ELEMENTS) throw new HtmlTooComplex();
    },
    onItemPop() {
      openElements--;
    },
    createElement(tagName, namespaceURI, attrs) {
      if (attrs.length > MAX_ATTRIBUTES) throw new HtmlTooComplex();
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    // A later <html> or <body> tag adds its attributes to the first one.
    adoptAttributes(recipient, attrs) {
      checkDeadline();
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
      if (recipient.attrs.length > MAX_ATTRIBUTES) throw new HtmlTooComplex();
    },
    appendChild(parent, child) {
      inserting();
      defaultTreeAdapter.appendChild(parent, child);
    },
    insertBefore(parent, child, reference) {
      inserting();
      defaultTreeAdapter.insertBefore(parent, child, reference);
    },
    insertText(parent, text) {
      inserting();
      defaultTreeAdapter.insertText(parent, text);
    },
    insertTextBefore(parent, text, reference) {
      inserting();
      defaultTreeAdapter.insertTextBefore(parent, text, reference);
    },
    detachNode(node) {
      checkDeadline();
      defaultTreeAdapter.detachNode(node);
    },
  };
}

// parse5's parse() does the same in one write. Its Parser class is marked internal, but it is the
// one way to feed the input in pieces; parse5-parser-stream uses it the same way.
function parseWithDeadline(html: string): Node {
  const deadline = performance.now() + MAX_PARSE_MS;
  const checkDeadline = () => {
    if (performance.now() > deadline) throw new HtmlTooComplex();
  };
  const parser = new Parser<DefaultTreeAdapterMap>({ treeAdapter: limitedAdapter(checkDeadline) });
  for (let start = 0; start < html.length; start += PARSE_CHUNK_CHARS) {
    parser.tokenizer.write(html.slice(start, start + PARSE_CHUNK_CHARS), false);
    checkDeadline();
  }
  parser.tokenizer.write("", true);
  return parser.document;
}

// Iterative, so deeply nested markup cannot overflow the call stack.
function documentEvents(html: string): Event[] {
  const events: Event[] = [];
  const stack: { node: Node; inLink: boolean }[] = [{ node: parseWithDeadline(html), inLink: false }];
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

// The URL parser runs the host through IDNA, which takes seconds on a long run of combining marks.
// Real hosts are short, so a link whose host part (after the scheme and slashes, up to the next
// slash, backslash, "?" or "#") is longer than any real host is not parsed. URL.parse returns null
// where the URL constructor would throw, so a flood of links without an href costs no exceptions.
const MAX_HOST_PART_CHARS = 255;
const HOST_PART = /^[^:]*:[\\/\t\n\r]*([^\\/?#]*)/;

function parseLink(href: string): URL | null {
  const hostPart = HOST_PART.exec(href)?.[1] ?? "";
  return hostPart.length <= MAX_HOST_PART_CHARS ? URL.parse(href) : null;
}

function savedSearchIdOf(href: string): string | null {
  const url = parseLink(href);
  if (url?.protocol !== "https:" || url.host !== "www.kleinanzeigen.de") return null;
  if (url.pathname !== "/m-suche-verwenden.html") return null;
  const id = url.searchParams.get("id") ?? "";
  return /^[0-9]{1,15}$/.test(id) ? id : null;
}

// null: not a listing link at all. A link into /s-anzeige/ in any other shape than the one we know
// means the layout changed, so the whole email is rejected rather than read half.
function listingLinkOf(href: string): { adId: string; savedSearchIds: string[] } | null | "bad_shape" {
  const url = parseLink(href);
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
  const url = parseLink(src ?? "");
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

// parse5 copies an <a> left open into every block it reopens, so one href can come back in
// thousands of link events. Each distinct href is read once per email.
function readOnce<T>(read: (href: string) => T): (href: string) => T {
  const results = new Map<string, { value: T }>();
  return (href) => {
    let entry = results.get(href);
    if (entry === undefined) {
      entry = { value: read(href) };
      results.set(href, entry);
    }
    return entry.value;
  };
}

// Anchored on links and text only, never on class names or styles: the "Neue Treffer ansehen"
// link opens the list, and each "Anzeige ansehen" link closes the block of text before it.
export function extractListings(html: string): ExtractedListings {
  let events: Event[];
  try {
    events = documentEvents(html);
  } catch (err) {
    return { ok: false, reason: "malformed", detail: err instanceof HtmlTooComplex ? "html_too_complex" : "html_parse_failed" };
  }
  const savedSearchIdIn = readOnce(savedSearchIdOf);
  const listingLinkIn = readOnce(listingLinkOf);
  let savedSearchId: string | null = null;
  let start = events.length;
  for (const [index, event] of events.entries()) {
    savedSearchId = event.kind === "link" ? savedSearchIdIn(event.href) : null;
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
    const link = event.kind === "link" ? listingLinkIn(event.href) : null;
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

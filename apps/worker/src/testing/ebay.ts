import type { Clock } from "@ebay-sniper/domain";
import {
  createAppTokenCache,
  createBrowseClient,
  createItemClient,
  type BrowseClientOptions,
  type EbayCallReservation,
  type FetchFn,
  type ReserveEbayCall,
} from "@ebay-sniper/ebay";

// A fake eBay for the worker tests: the real token cache, Browse client and item client run on an
// injected fetchFn that answers here, so no test reaches the network. Item IDs come from the fake
// range v1|9NNNNNNNNNNN|0 (ADR 0023), so they never match a real listing.

export const FAKE_API_BASE = "https://api.ebay.test";
const FAKE_TOKEN = "fake-access-token";

let nextItem = 0;

// A new fake legacy item ID on every call.
export function fakeLegacyItemId(): string {
  nextItem += 1;
  return `9${String(nextItem).padStart(11, "0")}`;
}

export type SummaryFields = {
  title?: string;
  // Decimal EUR string, as eBay sends it.
  price?: string;
  currency?: string;
  // null: no shipping cost for DE (unknown shipping).
  shipping?: string | null;
  buyingOptions?: string[];
  conditionId?: string;
  itemCreationDate?: string;
  itemEndDate?: string;
  legacyItemId?: string;
  categoryId?: string;
  seller?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

// An item summary as Browse search returns it. The seller username is in the raw body on purpose:
// the schema must drop it (A23).
export function itemSummary(fields: SummaryFields = {}): Record<string, unknown> {
  const legacyItemId = fields.legacyItemId ?? fakeLegacyItemId();
  const categoryId = fields.categoryId ?? "19006";
  const shipping = fields.shipping === undefined ? "10.00" : fields.shipping;
  return {
    itemId: `v1|${legacyItemId}|0`,
    legacyItemId,
    title: fields.title ?? "Synthetic listing",
    price: { value: fields.price ?? "450.00", currency: fields.currency ?? "EUR" },
    buyingOptions: fields.buyingOptions ?? ["FIXED_PRICE"],
    leafCategoryIds: [categoryId],
    categories: [{ categoryId, categoryName: "Synthetic category" }],
    condition: "Gebraucht",
    conditionId: fields.conditionId ?? "3000",
    shippingOptions:
      shipping === null
        ? [{ shippingCostType: "CALCULATED" }]
        : [{ shippingCostType: "FIXED", shippingCost: { value: shipping, currency: "EUR" } }],
    itemLocation: { country: "DE" },
    seller: {
      username: "fake-seller-name",
      feedbackPercentage: "100.0",
      feedbackScore: 250,
      sellerAccountType: "INDIVIDUAL",
      ...fields.seller,
    },
    itemCreationDate: fields.itemCreationDate ?? "2026-10-21T09:00:00.000Z",
    itemEndDate: fields.itemEndDate ?? "2026-11-20T09:00:00.000Z",
    itemWebUrl: `https://www.ebay.de/itm/${legacyItemId}`,
    ...fields.extra,
  };
}

// A search page body. `next` adds a next link, so the client sees more pages.
export function searchPage(
  items: unknown[],
  options: { next?: boolean; offset?: number; total?: number; warnings?: { errorId: number }[] } = {},
): Record<string, unknown> {
  const offset = options.offset ?? 0;
  return {
    total: options.total ?? offset + items.length + (options.next ? 1 : 0),
    limit: 200,
    offset,
    ...(options.next ? { next: `${FAKE_API_BASE}/buy/browse/v1/item_summary/search?offset=${offset + 200}` } : {}),
    ...(options.warnings ? { warnings: options.warnings } : {}),
    itemSummaries: items,
  };
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Never answers; rejects like fetch when the request's signal aborts.
export function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export type Responder = (url: URL, signal: AbortSignal | null | undefined) => Response | Promise<Response>;

export type FakeEbayRequest = { kind: "token" | "search" | "get_item"; url: URL; headers: Record<string, string> };

export type FakeEbay = ReturnType<typeof createFakeEbay>;

export function createFakeEbay() {
  const requests: FakeEbayRequest[] = [];
  const searchResponders: Responder[] = [];
  const itemResponders = new Map<string, Responder>();
  let onSearch: ((url: URL) => Promise<void> | void) | null = null;

  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const signal = init?.signal;
    if (url.pathname === "/identity/v1/oauth2/token") {
      requests.push({ kind: "token", url, headers });
      return json({ access_token: FAKE_TOKEN, expires_in: 7200, token_type: "Application Access Token" });
    }
    if (url.pathname === "/buy/browse/v1/item_summary/search") {
      requests.push({ kind: "search", url, headers });
      await onSearch?.(url);
      const responder = searchResponders.shift();
      return responder ? responder(url, signal) : json(searchPage([]));
    }
    const item = /^\/buy\/browse\/v1\/item\/(.+)$/.exec(url.pathname);
    if (item?.[1] !== undefined) {
      requests.push({ kind: "get_item", url, headers });
      const responder = itemResponders.get(decodeURIComponent(item[1]));
      return responder ? responder(url, signal) : json({ errors: [{ errorId: 11001 }] }, 404);
    }
    throw new Error(`unexpected fake eBay request: ${url.pathname}`);
  };

  return {
    fetchFn,
    requests,
    // The search requests sent, in order.
    searches: (): URL[] => requests.filter((r) => r.kind === "search").map((r) => r.url),
    // The next search requests get these answers, in order; after them, an empty page.
    searchPages(...pages: Record<string, unknown>[]) {
      for (const page of pages) searchResponders.push(() => json(page));
    },
    respondToSearch(...responders: Responder[]) {
      searchResponders.push(...responders);
    },
    // Runs before each search is answered, for checks of what the database holds at that moment.
    beforeSearch(check: (url: URL) => Promise<void> | void) {
      onSearch = check;
    },
    // getItem for the RESTful item ID answers with this body; unknown items get 404.
    item(itemId: string, body: Record<string, unknown> | Responder) {
      itemResponders.set(itemId, typeof body === "function" ? body : () => json(body));
    },
  };
}

function clientOptions(ebay: FakeEbay, clock: Clock, reserve: ReserveEbayCall): BrowseClientOptions {
  return {
    apiBase: FAKE_API_BASE,
    marketplaceId: "EBAY_DE",
    token: createAppTokenCache({
      apiBase: FAKE_API_BASE,
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      fetchFn: ebay.fetchFn,
      clock,
    }),
    fetchFn: ebay.fetchFn,
    reserve,
  };
}

// The real Browse search on the fake, built on the reservation the handler passes in.
export function testSearch(ebay: FakeEbay, clock: Clock) {
  return (reserve: ReserveEbayCall) => createBrowseClient(clientOptions(ebay, clock, reserve)).searchItems;
}

// The real getItem on the fake.
export function testGetItem(ebay: FakeEbay, clock: Clock) {
  return (reserve: ReserveEbayCall) => createItemClient(clientOptions(ebay, clock, reserve)).getItem;
}

// Stands in for reserve_ebay_call: answers "ok", or "pool" once refuse() was called, and keeps
// every reservation asked for. Tests use it so their clock need not match the database clock.
export function createFakeReserve() {
  const reservations: EbayCallReservation[] = [];
  let answer: "ok" | "pool" = "ok";
  return {
    reservations,
    reserve: async (reservation: EbayCallReservation) => {
      reservations.push(reservation);
      return answer;
    },
    refuse() {
      answer = "pool";
    },
  };
}

import { EbayError } from "../errors.js";
import { DEFAULT_TIMEOUT_MS, getJson, type AppTokenCache, type FetchFn } from "../http.js";
import { itemSummarySchema, searchPageSchema, type EbayErrorDetail, type ItemSummary } from "./schemas.js";

export type EbayCallReservation = {
  resource: "buy.browse";
  callClass: "standard" | "alert-path";
  purpose: string;
  minLeft: number;
};

export type ReserveEbayCall = (reservation: EbayCallReservation) => Promise<"ok" | "pool">;

export type BrowseSearchRequest = {
  q?: string;
  categoryIds?: string[];
  // Ready-built filter expressions, joined with ",".
  filter?: string[];
  sort?: string;
  // 1 to 200.
  limit: number;
  offset?: number;
  fieldgroups?: string[];
  // The exact X-EBAY-C-ENDUSERCTX value, already encoded.
  endUserContext?: string;
};

export type BrowseCallContext = {
  callClass: "standard" | "alert-path";
  purpose: string;
  minLeft: number;
  signal?: AbortSignal;
};

export type BrowseSearchPage = {
  total: number;
  limit: number;
  offset: number;
  next: string | undefined;
  warnings: EbayErrorDetail[];
  items: ItemSummary[];
  // Items that failed the schema: counted and skipped.
  malformedItems: number;
};

export type BrowseClientOptions = {
  apiBase: string;
  marketplaceId: "EBAY_DE";
  token: AppTokenCache;
  fetchFn: FetchFn;
  reserve: ReserveEbayCall;
  timeoutMs?: number;
};

function searchQuery(request: BrowseSearchRequest): string {
  const params: [string, string | undefined][] = [
    ["q", request.q],
    ["category_ids", request.categoryIds?.join(",")],
    ["filter", request.filter?.join(",")],
    ["sort", request.sort],
    ["limit", String(request.limit)],
    ["offset", request.offset === undefined ? undefined : String(request.offset)],
    ["fieldgroups", request.fieldgroups?.join(",")],
  ];
  return params
    .flatMap(([name, value]) => (value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`]))
    .join("&");
}

export function createBrowseClient(options: BrowseClientOptions) {
  const { apiBase, marketplaceId, token, fetchFn, reserve } = options;

  // Every attempt, retries included, reserves one unit first (ADR 0007). The token comes before the
  // reservation, so a token failure spends nothing; a refused or failed reservation sends nothing.
  async function searchItems(request: BrowseSearchRequest, call: BrowseCallContext): Promise<BrowseSearchPage> {
    const headers: Record<string, string> = {
      "x-ebay-c-marketplace-id": marketplaceId,
      accept: "application/json",
    };
    if (request.endUserContext !== undefined) headers["x-ebay-c-enduserctx"] = request.endUserContext;

    const { body, attempts } = await getJson({
      operation: "search",
      fetchFn,
      token,
      url: `${apiBase}/buy/browse/v1/item_summary/search?${searchQuery(request)}`,
      headers,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: call.signal,
      beforeAttempt: async (attemptsSoFar) => {
        const reservation = await reserve({
          resource: "buy.browse",
          callClass: call.callClass,
          purpose: call.purpose,
          minLeft: call.minLeft,
        });
        if (reservation !== "ok") {
          throw new EbayError({ kind: "quota_refused", operation: "search", attempts: attemptsSoFar });
        }
      },
    });

    const parsed = searchPageSchema.safeParse(body);
    if (!parsed.success) throw new EbayError({ kind: "invalid_response", operation: "search", attempts });
    const page = parsed.data;
    const items: ItemSummary[] = [];
    let malformedItems = 0;
    for (const raw of page.itemSummaries ?? []) {
      const item = itemSummarySchema.safeParse(raw);
      if (item.success) items.push(item.data);
      else malformedItems += 1;
    }
    return {
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      next: page.next,
      warnings: page.warnings ?? [],
      items,
      malformedItems,
    };
  }

  return { searchItems };
}

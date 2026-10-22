import { EbayError } from "../errors.js";
import { DEFAULT_TIMEOUT_MS, getJson } from "../http.js";
import { itemSchema, type Item } from "./schemas.js";
import type { BrowseCallContext, BrowseClientOptions } from "./search.js";

export type GetItemRequest = {
  // The exact X-EBAY-C-ENDUSERCTX value, already encoded, so shipping costs are for DE.
  endUserContext?: string;
};

export type GetItemResult = { status: "found"; item: Item } | { status: "not_found" };

export function createItemClient(options: BrowseClientOptions) {
  const { apiBase, marketplaceId, token, fetchFn, reserve } = options;

  // itemId is the RESTful ID ("v1|<legacy id>|0"). Same A20 policy as search: at most 3 attempts,
  // each one reserved first (ADR 0007), the token fetched before the reservation.
  async function getItem(itemId: string, request: GetItemRequest, call: BrowseCallContext): Promise<GetItemResult> {
    const headers: Record<string, string> = {
      "x-ebay-c-marketplace-id": marketplaceId,
      accept: "application/json",
    };
    if (request.endUserContext !== undefined) headers["x-ebay-c-enduserctx"] = request.endUserContext;

    const response = await getJson({
      operation: "get_item",
      fetchFn,
      token,
      url: `${apiBase}/buy/browse/v1/item/${encodeURIComponent(itemId)}`,
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
          throw new EbayError({ kind: "quota_refused", operation: "get_item", attempts: attemptsSoFar });
        }
      },
    }).catch((error: unknown) => {
      // eBay answers 404 for an unknown or removed item; the 404 itself is not retried. An item
      // that is still returned but has ended shows it in itemEndDate, which the caller checks.
      if (error instanceof EbayError && error.kind === "client_error" && error.status === 404) return null;
      throw error;
    });
    if (response === null) return { status: "not_found" };

    const parsed = itemSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new EbayError({ kind: "invalid_response", operation: "get_item", attempts: response.attempts });
    }
    return { status: "found", item: parsed.data };
  }

  return { getItem };
}

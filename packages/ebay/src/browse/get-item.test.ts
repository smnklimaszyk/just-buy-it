import { describe, expect, it } from "vitest";
import { EbayError } from "../errors.js";
import { buildItem } from "../testing/browse.js";
import { createAppTokenCache } from "../token.js";
import { createItemClient } from "./get-item.js";
import type { EbayCallReservation, ReserveEbayCall } from "./search.js";

type Call = { url: string; init: RequestInit | undefined };
type ItemResponder = (n: number, init: RequestInit | undefined) => Response | Promise<Response>;

// One fake eBay for the token and getItem endpoints. Token n is "t<n>". Every request and
// reservation is recorded in order.
function fakeEbay(respond: ItemResponder) {
  const events: string[] = [];
  const requests: Call[] = [];
  let tokens = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/identity/v1/oauth2/token")) {
      tokens += 1;
      events.push("token");
      return Response.json({ access_token: `t${tokens}`, expires_in: 7200 });
    }
    requests.push({ url, init });
    events.push("fetch");
    return respond(requests.length, init);
  };
  const reservations: EbayCallReservation[] = [];
  const reserve: ReserveEbayCall = async (r) => {
    reservations.push(r);
    events.push("reserve");
    return "ok";
  };
  return { events, requests, reservations, fetchFn, reserve, tokenRequests: () => tokens };
}

function itemClient(ebay: ReturnType<typeof fakeEbay>, extra: { timeoutMs?: number } = {}) {
  const token = createAppTokenCache({
    apiBase: "https://api.ebay.com",
    clientId: "app-id",
    clientSecret: "cert-id",
    fetchFn: ebay.fetchFn,
    clock: { now: () => new Date(0) },
  });
  return createItemClient({
    apiBase: "https://api.ebay.com",
    marketplaceId: "EBAY_DE",
    token,
    fetchFn: ebay.fetchFn,
    reserve: ebay.reserve,
    ...extra,
  });
}

const call = { callClass: "alert-path", purpose: "enrich", minLeft: 100 } as const;
const endUserContext = "contextualLocation=country%3DDE%2Czip%3D80331";

describe("getItem", () => {
  it("gets the item by its encoded ID with the token, marketplace and end user context headers", async () => {
    const item = buildItem({ itemId: "v1|900000000001|0", legacyItemId: "900000000001" });
    const ebay = fakeEbay(() => Response.json(item));
    const client = itemClient(ebay);

    const result = await client.getItem("v1|900000000001|0", { endUserContext }, call);

    expect(result).toEqual({ status: "found", item });
    expect(ebay.requests).toHaveLength(1);
    expect(ebay.requests[0]?.url).toBe("https://api.ebay.com/buy/browse/v1/item/v1%7C900000000001%7C0");
    const headers = new Headers(ebay.requests[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer t1");
    expect(headers.get("x-ebay-c-marketplace-id")).toBe("EBAY_DE");
    expect(headers.get("x-ebay-c-enduserctx")).toBe(endUserContext);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("maps a 404 to not_found after one reserved attempt", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [{ errorId: 11001 }] }, { status: 404 }));
    const client = itemClient(ebay);

    await expect(client.getItem("v1|900000000002|0", { endUserContext }, call)).resolves.toEqual({
      status: "not_found",
    });
    expect(ebay.requests).toHaveLength(1);
    expect(ebay.reservations).toHaveLength(1);
  });

  it("reserves before each attempt and throws after the third failed attempt (A20)", async () => {
    // 401 on the first token, then two 5xx: token refresh, one retry, then the error.
    const ebay = fakeEbay((n) =>
      n === 1 ? Response.json({ errors: [{ errorId: 1001 }] }, { status: 401 }) : new Response("busy", { status: 503 }),
    );
    const client = itemClient(ebay);

    await expect(client.getItem("v1|900000000003|0", { endUserContext }, call)).rejects.toMatchObject({
      kind: "server_error",
      operation: "get_item",
      status: 503,
      attempts: 3,
    });
    expect(ebay.events).toEqual(["token", "reserve", "fetch", "token", "reserve", "fetch", "reserve", "fetch"]);
    const reservation = { resource: "buy.browse", callClass: "alert-path", purpose: "enrich", minLeft: 100 };
    expect(ebay.reservations).toEqual([reservation, reservation, reservation]);
  });

  it("sends nothing and fails with quota_refused when the reservation is refused", async () => {
    const ebay = fakeEbay(() => Response.json(buildItem()));
    ebay.reserve = async () => "pool";
    const client = itemClient(ebay);

    await expect(client.getItem("v1|900000000004|0", { endUserContext }, call)).rejects.toMatchObject({
      kind: "quota_refused",
      operation: "get_item",
      attempts: 0,
    });
    expect(ebay.requests).toHaveLength(0);
  });

  it("drops the seller's identity and legal info from the parsed item (A23)", async () => {
    const item = buildItem();
    const ebay = fakeEbay(() =>
      Response.json({
        ...item,
        seller: { ...(item.seller as object), username: "SENTINEL_SELLER_7f3a", userId: "SENTINEL_SELLER_7f3a" },
        sellerLegalInfo: { legalContactFirstName: "SENTINEL_SELLER_7f3a" },
        responsiblePersons: [{ companyName: "SENTINEL_SELLER_7f3a" }],
      }),
    );
    const client = itemClient(ebay);

    const result = await client.getItem("v1|900000000005|0", { endUserContext }, call);

    expect(result).toEqual({ status: "found", item });
    expect(JSON.stringify(result)).not.toContain("SENTINEL_SELLER_7f3a");
  });

  it.each([
    ["a body that fails the schema", () => Response.json({ itemId: 7, title: "body-sentinel" })],
    ["a body that is not JSON", () => new Response("body-sentinel <html>")],
  ])("fails with invalid_response on %s, without the body in the error", async (_name, respond) => {
    const ebay = fakeEbay(respond);
    const client = itemClient(ebay);

    const error = await client.getItem("v1|900000000006|0", { endUserContext }, call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EbayError);
    expect(error).toMatchObject({ kind: "invalid_response", operation: "get_item", attempts: 1 });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("body-sentinel");
    expect(ebay.reservations).toHaveLength(1);
  });

  it("passes other 4xx answers on as client_error, not as not_found", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [{ errorId: 11006 }] }, { status: 409 }));
    const client = itemClient(ebay);

    await expect(client.getItem("v1|900000000007|0", { endUserContext }, call)).rejects.toMatchObject({
      kind: "client_error",
      operation: "get_item",
      status: 409,
      errorIds: [11006],
      attempts: 1,
    });
  });
});

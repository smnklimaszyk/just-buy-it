import { describe, expect, it } from "vitest";
import { EbayError } from "../errors.js";
import { buildItemSummary, buildSearchPage } from "../testing/browse.js";
import { createAppTokenCache } from "../token.js";
import { createBrowseClient, type EbayCallReservation, type ReserveEbayCall } from "./search.js";

type Call = { url: string; init: RequestInit | undefined };
type SearchResponder = (n: number, init: RequestInit | undefined) => Response | Promise<Response>;

const emptyPage = () => Response.json({ total: 0, limit: 10, offset: 0 });

// One fake eBay for both endpoints. Token n is "t<n>". Every request and reservation is recorded in order.
function fakeEbay(respond: SearchResponder = emptyPage) {
  const events: string[] = [];
  const searches: Call[] = [];
  let tokens = 0;
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/identity/v1/oauth2/token")) {
      tokens += 1;
      events.push("token");
      return Response.json({ access_token: `t${tokens}`, expires_in: 7200 });
    }
    searches.push({ url, init });
    events.push("fetch");
    return respond(searches.length, init);
  };
  const reservations: EbayCallReservation[] = [];
  const reserve: ReserveEbayCall = async (r) => {
    reservations.push(r);
    events.push("reserve");
    return "ok";
  };
  return { events, searches, reservations, fetchFn, reserve, tokenRequests: () => tokens };
}

// Behaves like fetch on a host that never answers: it settles only when the signal aborts.
function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

function browseClient(ebay: ReturnType<typeof fakeEbay>, extra: { timeoutMs?: number } = {}) {
  const token = createAppTokenCache({
    apiBase: "https://api.ebay.com",
    clientId: "app-id",
    clientSecret: "cert-id",
    fetchFn: ebay.fetchFn,
    clock: { now: () => new Date(0) },
  });
  return createBrowseClient({
    apiBase: "https://api.ebay.com",
    marketplaceId: "EBAY_DE",
    token,
    fetchFn: ebay.fetchFn,
    reserve: ebay.reserve,
    ...extra,
  });
}

const call = { callClass: "standard", purpose: "contract", minLeft: 100 } as const;

describe("searchItems", () => {
  it("sends the encoded query with the token, marketplace and end user context headers", async () => {
    const ebay = fakeEbay();
    const client = browseClient(ebay);

    await client.searchItems(
      {
        q: "lego 10305 & more",
        categoryIds: ["19006", "183446"],
        filter: ["buyingOptions:{AUCTION}", "price:[10..50]"],
        sort: "endingSoonest",
        limit: 50,
        offset: 100,
        fieldgroups: ["MATCHING_ITEMS", "EXTENDED"],
        endUserContext: "contextualLocation=country%3DDE",
      },
      call,
    );

    expect(ebay.searches).toHaveLength(1);
    expect(ebay.searches[0]?.url).toBe(
      "https://api.ebay.com/buy/browse/v1/item_summary/search" +
        "?q=lego%2010305%20%26%20more" +
        "&category_ids=19006%2C183446" +
        "&filter=buyingOptions%3A%7BAUCTION%7D%2Cprice%3A%5B10..50%5D" +
        "&sort=endingSoonest" +
        "&limit=50" +
        "&offset=100" +
        "&fieldgroups=MATCHING_ITEMS%2CEXTENDED",
    );
    const headers = new Headers(ebay.searches[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer t1");
    expect(headers.get("x-ebay-c-marketplace-id")).toBe("EBAY_DE");
    expect(headers.get("x-ebay-c-enduserctx")).toBe("contextualLocation=country%3DDE");
    expect(headers.get("accept")).toBe("application/json");
  });

  it("gets the token, then reserves one unit with only the reservation fields, then sends the request", async () => {
    const ebay = fakeEbay();
    const client = browseClient(ebay);

    await client.searchItems({ q: "lego", limit: 10 }, { ...call, signal: new AbortController().signal });

    expect(ebay.events).toEqual(["token", "reserve", "fetch"]);
    expect(ebay.reservations).toEqual([
      { resource: "buy.browse", callClass: "standard", purpose: "contract", minLeft: 100 },
    ]);
  });

  it("sends nothing and fails with quota_refused when the reservation is refused", async () => {
    const ebay = fakeEbay();
    ebay.reserve = async () => "pool";
    const client = browseClient(ebay);

    const error = await client.searchItems({ q: "lego", limit: 10 }, call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EbayError);
    expect(error).toMatchObject({ kind: "quota_refused", operation: "search", attempts: 0 });
    expect(ebay.searches).toHaveLength(0);
  });

  it("sends nothing and passes the error on when the reservation itself fails", async () => {
    const ebay = fakeEbay();
    const databaseDown = new Error("connect ECONNREFUSED");
    ebay.reserve = async () => {
      throw databaseDown;
    };
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toBe(databaseDown);
    expect(ebay.searches).toHaveLength(0);
  });

  it("reserves nothing when there is no token", async () => {
    const ebay = fakeEbay();
    const client = createBrowseClient({
      apiBase: "https://api.ebay.com",
      marketplaceId: "EBAY_DE",
      token: {
        get: async () => {
          throw new EbayError({ kind: "unauthorized", operation: "token", status: 401, attempts: 1 });
        },
        invalidate: () => undefined,
      },
      fetchFn: ebay.fetchFn,
      reserve: ebay.reserve,
    });

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toMatchObject({ operation: "token" });
    expect(ebay.reservations).toHaveLength(0);
    expect(ebay.searches).toHaveLength(0);
  });
});

describe("searchItems retries (A20)", () => {
  it("does not retry a 429", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [] }, { status: 429 }));
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toMatchObject({
      kind: "rate_limited",
      operation: "search",
      status: 429,
      attempts: 1,
    });
    expect(ebay.searches).toHaveLength(1);
    expect(ebay.reservations).toHaveLength(1);
  });

  it("retries a 5xx once and reserves the retry too", async () => {
    const ebay = fakeEbay((n) => (n === 1 ? new Response("busy", { status: 503 }) : emptyPage()));
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).resolves.toMatchObject({ total: 0 });
    expect(ebay.events).toEqual(["token", "reserve", "fetch", "reserve", "fetch"]);
  });

  it("fails with server_error after a second 5xx", async () => {
    const ebay = fakeEbay((n) => (n <= 2 ? new Response("busy", { status: 503 }) : emptyPage()));
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toMatchObject({
      kind: "server_error",
      status: 503,
      attempts: 2,
    });
    expect(ebay.searches).toHaveLength(2);
    expect(ebay.reservations).toHaveLength(2);
  });

  it("retries a timeout once, with a fresh timeout for the second attempt", async () => {
    const ebay = fakeEbay((n, init) => (n === 1 ? waitForAbort(init?.signal) : emptyPage()));
    const client = browseClient(ebay, { timeoutMs: 20 });

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).resolves.toMatchObject({ total: 0 });
    expect(ebay.searches).toHaveLength(2);
    expect(ebay.reservations).toHaveLength(2);
    expect(ebay.searches[1]?.init?.signal?.aborted).toBe(false);
  });

  it("retries a network error once and fails with network after the second", async () => {
    const ebay = fakeEbay(() => {
      throw new TypeError("fetch failed");
    });
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toMatchObject({
      kind: "network",
      attempts: 2,
    });
    expect(ebay.reservations).toHaveLength(2);
  });

  it("does not retry a 400 and keeps only the error ids from the body", async () => {
    const ebay = fakeEbay(() =>
      Response.json(
        { errors: [{ errorId: 12034, message: "body-sentinel", longMessage: "body-sentinel" }] },
        { status: 400 },
      ),
    );
    const client = browseClient(ebay);

    const error = await client.searchItems({ q: "lego", limit: 10 }, call).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "client_error", status: 400, errorIds: [12034], attempts: 1 });
    expect(JSON.stringify(error)).not.toContain("body-sentinel");
    expect((error as Error).message).toBe("eBay search failed: client_error (HTTP 400)");
    expect(ebay.searches).toHaveLength(1);
  });

  it("stops with aborted and no retry when the caller aborts", async () => {
    const caller = new AbortController();
    const ebay = fakeEbay((_n, init) => {
      const pending = waitForAbort(init?.signal);
      caller.abort();
      return pending;
    });
    const client = browseClient(ebay);

    await expect(
      client.searchItems({ q: "lego", limit: 10 }, { ...call, signal: caller.signal }),
    ).rejects.toMatchObject({ kind: "aborted", attempts: 1 });
    expect(ebay.searches).toHaveLength(1);
    expect(ebay.reservations).toHaveLength(1);
  });

  it("refreshes the token once for ten parallel searches that get a 401 on the same token", async () => {
    const ebay = fakeEbay((_n, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer t1"
        ? Response.json({ errors: [{ errorId: 1001 }] }, { status: 401 })
        : emptyPage(),
    );
    const client = browseClient(ebay);

    const pages = await Promise.all(
      Array.from({ length: 10 }, () => client.searchItems({ q: "lego", limit: 10 }, call)),
    );

    expect(pages).toHaveLength(10);
    expect(ebay.tokenRequests()).toBe(2);
    const retriedWith = ebay.searches.slice(10).map((s) => new Headers(s.init?.headers).get("authorization"));
    expect(retriedWith).toEqual(Array.from({ length: 10 }, () => "Bearer t2"));
    expect(ebay.reservations).toHaveLength(20);
  });

  it("fails with unauthorized when the refreshed token gets a 401 too", async () => {
    const ebay = fakeEbay(() => Response.json({ errors: [{ errorId: 1001 }] }, { status: 401 }));
    const client = browseClient(ebay);

    await expect(client.searchItems({ q: "lego", limit: 10 }, call)).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
      errorIds: [1001],
      attempts: 2,
    });
    expect(ebay.tokenRequests()).toBe(2);
    expect(ebay.reservations).toHaveLength(2);
  });
});

describe("searchItems parsing", () => {
  it("returns the page fields and the parsed items", async () => {
    const item = buildItemSummary();
    const ebay = fakeEbay(() =>
      Response.json(buildSearchPage([item], { total: 120, offset: 50, next: "https://api.ebay.com/next" })),
    );
    const client = browseClient(ebay);

    const page = await client.searchItems({ q: "lego", limit: 50, offset: 50 }, call);

    expect(page).toEqual({
      total: 120,
      limit: 50,
      offset: 50,
      next: "https://api.ebay.com/next",
      warnings: [],
      items: [item],
      malformedItems: 0,
    });
  });

  it("skips and counts an item that fails the schema", async () => {
    const good = [buildItemSummary(), buildItemSummary()];
    const bad = buildItemSummary({ bidCount: "three" });
    const ebay = fakeEbay(() => Response.json(buildSearchPage([good[0], bad, good[1]])));
    const client = browseClient(ebay);

    const page = await client.searchItems({ q: "lego", limit: 50 }, call);

    expect(page.items).toEqual(good);
    expect(page.malformedItems).toBe(1);
  });

  it("drops seller.username and sellerLegalInfo from items and from errors (A23)", async () => {
    const withSellerIdentity = buildItemSummary({
      seller: { username: "seller-sentinel", feedbackScore: 10, userId: "seller-sentinel" },
      sellerLegalInfo: { legalContactFirstName: "seller-sentinel", email: "seller-sentinel@example.invalid" },
    });
    const ebay = fakeEbay((n) =>
      n === 1
        ? Response.json(buildSearchPage([withSellerIdentity]))
        : Response.json(buildSearchPage([withSellerIdentity], { total: "bad" }), { status: n === 2 ? 200 : 400 }),
    );
    const client = browseClient(ebay);

    const page = await client.searchItems({ q: "lego", limit: 50 }, call);
    const invalid = await client.searchItems({ q: "lego", limit: 50 }, call).catch((e: unknown) => e);
    const rejected = await client.searchItems({ q: "lego", limit: 50 }, call).catch((e: unknown) => e);

    expect(page.items[0]?.seller).toEqual({ feedbackScore: 10 });
    expect(JSON.stringify(page)).not.toContain("seller-sentinel");
    expect(JSON.stringify(page)).not.toContain("sellerLegalInfo");
    for (const error of [invalid, rejected]) {
      expect(error).toBeInstanceOf(EbayError);
      expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("seller-sentinel");
    }
  });

  it("returns no items when eBay sends no itemSummaries, and passes warnings on as data", async () => {
    const warning = { errorId: 12001, category: "REQUEST", domain: "API_BROWSE", message: "dropped" };
    const ebay = fakeEbay(() => Response.json({ total: 0, limit: 50, offset: 0, warnings: [warning] }));
    const client = browseClient(ebay);

    const page = await client.searchItems({ q: "lego", limit: 50 }, call);

    expect(page.items).toEqual([]);
    expect(page.malformedItems).toBe(0);
    expect(page.warnings).toEqual([{ errorId: 12001, category: "REQUEST", domain: "API_BROWSE" }]);
  });

  it("keeps the page when a warning has no errorId", async () => {
    const item = buildItemSummary();
    const ebay = fakeEbay(() =>
      Response.json({ total: 1, limit: 50, offset: 0, warnings: [{ category: "REQUEST" }], itemSummaries: [item] }),
    );
    const client = browseClient(ebay);

    const page = await client.searchItems({ q: "lego", limit: 50 }, call);

    expect(page.items).toEqual([item]);
    expect(page.warnings).toEqual([{ category: "REQUEST" }]);
  });

  it.each([
    ["a bad envelope", () => Response.json({ total: "body-sentinel", limit: 50, offset: 0 })],
    ["a body that is not JSON", () => new Response("body-sentinel <html>")],
  ])("fails with invalid_response on %s, without the body in the error", async (_name, respond) => {
    const ebay = fakeEbay(respond);
    const client = browseClient(ebay);

    const error = await client.searchItems({ q: "lego", limit: 50 }, call).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EbayError);
    expect(error).toMatchObject({ kind: "invalid_response", operation: "search", attempts: 1 });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("body-sentinel");
    expect(ebay.searches).toHaveLength(1);
  });
});

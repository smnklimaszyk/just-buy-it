import { describe, expect, it } from "vitest";
import { EbayError } from "./errors.js";
import { getJson, type GetJsonOptions } from "./http.js";

type Responder = (n: number, init: RequestInit | undefined) => Response | Promise<Response>;

// Behaves like fetch on a host that never answers: it settles only when the signal aborts.
function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason));
  });
}

// Behaves like a body whose headers arrived but whose bytes never do: it errors when the signal aborts.
function stalledBody(signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
    },
  });
}

// Token n is "t<n>". Every token request, hook call and request is recorded in order.
function setup(respond: Responder, overrides: Partial<GetJsonOptions> = {}) {
  const events: string[] = [];
  const requests: RequestInit[] = [];
  let tokens = 0;
  let cached: string | undefined;
  const options: GetJsonOptions = {
    operation: "public_key",
    fetchFn: async (_input, init) => {
      requests.push(init ?? {});
      events.push("fetch");
      return respond(requests.length, init);
    },
    token: {
      get: async () => {
        if (cached) return cached;
        tokens += 1;
        events.push("token");
        cached = `t${tokens}`;
        return cached;
      },
      invalidate: (t) => {
        if (cached === t) cached = undefined;
      },
    },
    url: "https://api.ebay.com/x",
    headers: { accept: "application/json" },
    timeoutMs: 1000,
    beforeAttempt: async () => {
      events.push("before");
    },
    ...overrides,
  };
  return { options, events, requests, tokenRequests: () => tokens };
}

describe("getJson", () => {
  it("sends the headers with the bearer token and returns the body", async () => {
    const s = setup(() => Response.json({ key: "k" }));

    await expect(getJson(s.options)).resolves.toEqual({ body: { key: "k" }, attempts: 1 });

    const headers = new Headers(s.requests[0]?.headers);
    expect(headers.get("authorization")).toBe("Bearer t1");
    expect(headers.get("accept")).toBe("application/json");
    expect(s.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(s.events).toEqual(["token", "before", "fetch"]);
  });

  it("retries a 5xx once, running the hook again, then fails with server_error and the error ids", async () => {
    const s = setup(() => Response.json({ errors: [{ errorId: 10001, message: "x" }] }, { status: 500 }));

    await expect(getJson(s.options)).rejects.toMatchObject({
      kind: "server_error",
      operation: "public_key",
      status: 500,
      errorIds: [10001],
      attempts: 2,
    });
    expect(s.events).toEqual(["token", "before", "fetch", "before", "fetch"]);
  });

  it.each([
    [429, "rate_limited"],
    [404, "client_error"],
  ])("does not retry HTTP %i and fails with %s", async (status, kind) => {
    const s = setup(() => Response.json({ errors: [] }, { status }));

    await expect(getJson(s.options)).rejects.toMatchObject({ kind, status, attempts: 1 });
    expect(s.requests).toHaveLength(1);
  });

  it("drops the rejected token on a 401, tries once more with a new one, then fails with unauthorized", async () => {
    const s = setup(() => Response.json({ errors: [] }, { status: 401 }));

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "unauthorized", status: 401, attempts: 2 });
    expect(s.tokenRequests()).toBe(2);
    expect(s.requests.map((r) => new Headers(r.headers).get("authorization"))).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("retries a timeout once with a fresh timeout, then fails with timeout", async () => {
    const s = setup((_n, init) => waitForAbort(init?.signal), { timeoutMs: 20 });

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "timeout", attempts: 2 });
    expect(s.events).toEqual(["token", "before", "fetch", "before", "fetch"]);
  });

  it("treats a 2xx body that stalls past the timeout like a timeout: one retry, then timeout", async () => {
    const s = setup((_n, init) => new Response(stalledBody(init?.signal)), { timeoutMs: 20 });

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "timeout", operation: "public_key", attempts: 2 });
    expect(s.events).toEqual(["token", "before", "fetch", "before", "fetch"]);
  });

  it("retries a network error once, then fails with network", async () => {
    const s = setup(() => {
      throw new TypeError("fetch failed");
    });

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "network", attempts: 2 });
    expect(s.requests).toHaveLength(2);
  });

  it("stops with aborted and no retry when the caller aborts", async () => {
    const caller = new AbortController();
    const s = setup(
      (_n, init) => {
        const pending = waitForAbort(init?.signal);
        caller.abort();
        return pending;
      },
      { signal: caller.signal },
    );

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "aborted", attempts: 1 });
    expect(s.requests).toHaveLength(1);
  });

  it("reports a caller abort during the token wait under the caller's operation", async () => {
    const s = setup(() => Response.json({}), {
      signal: AbortSignal.abort(),
      token: {
        get: async () => {
          throw new EbayError({ kind: "aborted", operation: "token", attempts: 0 });
        },
        invalidate: () => undefined,
      },
    });

    await expect(getJson(s.options)).rejects.toMatchObject({ kind: "aborted", operation: "public_key", attempts: 0 });
    expect(s.events).toEqual([]);
  });

  it("passes the caller's signal to the token cache", async () => {
    const caller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const s = setup(() => Response.json({}), {
      signal: caller.signal,
      token: {
        get: async (signal) => {
          seen.push(signal);
          return "t1";
        },
        invalidate: () => undefined,
      },
    });

    await getJson(s.options);

    expect(seen).toEqual([caller.signal]);
  });

  it("fails with invalid_response when a 2xx body is not JSON, without the body in the error", async () => {
    const s = setup(() => new Response("body-sentinel <html>"));

    const error = await getJson(s.options).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "invalid_response", attempts: 1 });
    expect(`${String(error)} ${JSON.stringify(error)}`).not.toContain("body-sentinel");
  });
});

// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollMarket } from "./market-poll.js";

const BOX = `<section data-market-poll="/products/bike/market"><span class="ia-badge">Checking</span></section>`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("market-poll", () => {
  it("asks the market URL every 3 s, marked as an automatic request, and reloads the page once the check is done", async () => {
    const answers = [{ checking: true }, { checking: false }];
    const fetchFn = vi.fn(async () => Response.json(answers.shift()));
    vi.stubGlobal("fetch", fetchFn);
    const reload = vi.fn();
    document.body.innerHTML = BOX;

    pollMarket(document, reload);
    await vi.advanceTimersByTimeAsync(2999);
    expect(fetchFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/products/bike/market");
    expect(new Headers(init.headers).get("X-Auto-Refresh")).toBe("1");
    expect(reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("stops quietly, keeping the page as it is, when the server refuses, the network fails or the reply is not JSON", async () => {
    const replies = [
      async () => new Response("Gone", { status: 404 }),
      async () => Promise.reject(new TypeError("offline")),
      async () => new Response("<html>", { status: 200 }),
    ];
    for (const reply of replies) {
      const fetchFn = vi.fn(reply);
      vi.stubGlobal("fetch", fetchFn);
      const reload = vi.fn();
      document.body.innerHTML = BOX;

      pollMarket(document, reload);
      await vi.advanceTimersByTimeAsync(3000 * 5);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
    }
  });

  it("gives up after 2 minutes of checking, so a stuck snapshot does not poll forever", async () => {
    const fetchFn = vi.fn(async () => Response.json({ checking: true }));
    vi.stubGlobal("fetch", fetchFn);
    document.body.innerHTML = BOX;

    pollMarket(document, vi.fn());
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

    expect(fetchFn).toHaveBeenCalledTimes(40);
  });

  it("starts polling as soon as the module loads, and not at all on a page without a running check", async () => {
    const fetchFn = vi.fn(async () => Response.json({ checking: true }));
    vi.stubGlobal("fetch", fetchFn);

    document.body.innerHTML = `<section>No check running</section>`;
    vi.resetModules();
    await import("./market-poll.js");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).not.toHaveBeenCalled();

    document.body.innerHTML = BOX;
    vi.resetModules();
    await import("./market-poll.js");
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

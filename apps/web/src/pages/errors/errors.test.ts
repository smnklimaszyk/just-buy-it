import { createPool } from "@ebay-sniper/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../app.js";
import { addPerson, createHarness, signIn, type Harness } from "../../testing/harness.js";

// Spec 8.3: the 403, 404 and 500 pages.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

// Made in the first test rather than in beforeAll, so a failure to build the app shows as that
// test's error.
const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

describe("error pages", () => {
  it("shows a signed-in browser the 404 page for a path that does not exist", async () => {
    const hh = await harness();
    await addPerson(hh, "info@intra-ai.de", "admin");
    const browser = hh.browser();
    await signIn(hh, browser, "info@intra-ai.de");

    const response = await browser.get("/no-such-page");

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("This page does not exist.");
    expect(html).toContain('class="ia-errstate"');
  });

  it("shows the 500 page when a request fails, and logs the error by its name only", async () => {
    const hh = await harness();
    const signedIn = hh.browser();
    await signIn(hh, signedIn, "info@intra-ai.de");
    // Nothing listens on port 1, so every query of this app fails.
    const deadPool = createPool({ connectionString: "postgres://web@127.0.0.1:1/none", max: 1, applicationName: "web-test-dead", onError: () => undefined });
    const app = createApp({ ...hh.deps, pool: deadPool });

    const response = await app.request("/deals", { headers: { Cookie: `__Host-jbi_session=${signedIn.cookies.get("__Host-jbi_session")}` } });

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("The page could not load. Nothing was changed.");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(hh.testLog.events("request_failed")).toEqual([{ event: "request_failed", err_name: "Error", method: "GET", route: "/deals" }]);
    await deadPool.end();
  });
});

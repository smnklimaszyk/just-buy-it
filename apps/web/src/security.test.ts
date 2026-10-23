import { afterAll, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./testing/harness.js";

// Spec 7.11: the headers on every response of web.

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

// Made in the first test rather than in beforeAll, so a failure to build the app shows as that
// test's error.
const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

const EXPECTED = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "x-robots-tag": "noindex, nofollow",
};

const headersOf = (response: Response) => Object.fromEntries(Object.keys(EXPECTED).map((name) => [name, response.headers.get(name)]));

describe("security headers", () => {
  it("are on a page, a redirect, a 401 and a 403, with Cache-Control no-store and no CORS headers", async () => {
    const browser = (await harness()).browser();
    const responses = {
      page: await browser.get("/login"),
      redirect: await browser.get("/deals"),
      unauthorized: await browser.post("/deals", {}),
      crossSite: await browser.post("/login", {}, { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" }),
    };

    for (const [name, response] of Object.entries(responses)) {
      expect(headersOf(response), name).toEqual(EXPECTED);
      expect(response.headers.get("cache-control"), name).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin"), name).toBeNull();
    }
    expect(responses.unauthorized.status).toBe(401);
    expect(responses.crossSite.status).toBe(403);
  });
});

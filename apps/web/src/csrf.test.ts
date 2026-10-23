import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addPerson, createHarness, formToken, PUBLIC_ORIGIN, signIn, type Browser, type Harness } from "./testing/harness.js";

// Spec 7.6 and auth.md 15: the CSRF refusals, against Postgres 18.

let h: Harness;
let owner: Browser;
let csrf: string;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  h = await createHarness();
  await addPerson(h, "info@intra-ai.de", "admin");
  owner = h.browser("198.51.100.7");
  await signIn(h, owner, "info@intra-ai.de");
  csrf = formToken(await (await owner.get("/deals")).text());
}, 60_000);

afterAll(async () => {
  await h.db.drop();
});

describe("CSRF", () => {
  it("refuses a signed-in form post without the session's token, or with another, with 403", async () => {
    expect((await owner.post("/products", {})).status).toBe(403);
    expect((await owner.post("/products", { _csrf: "not-the-token" })).status).toBe(403);
    // With the token the request reaches the routes (the stub has no POST).
    expect((await owner.post("/products", { _csrf: csrf })).status).toBe(404);
  });

  it("refuses any non-GET request that is neither Sec-Fetch-Site same-origin nor from PUBLIC_ORIGIN, public routes too", async () => {
    const crossSite = { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" };
    expect((await owner.post("/products", { _csrf: csrf }, crossSite)).status).toBe(403);
    expect((await owner.post("/login", { email: "info@intra-ai.de" }, crossSite)).status).toBe(403);

    // A JSON post with neither header: hono/csrf alone would let it pass (auth.md 10).
    const json = await h.app.request("/products", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Cookie: `__Host-jbi_session=${owner.cookies.get("__Host-jbi_session")}` },
      body: "{}",
    });
    expect(json.status).toBe(403);

    // A browser that sends Origin but not Sec-Fetch-Site passes when it is the public origin.
    expect((await owner.post("/products", { _csrf: csrf }, { "Sec-Fetch-Site": "", Origin: PUBLIC_ORIGIN })).status).toBe(404);
    expect((await owner.post("/products", { _csrf: csrf }, { "Sec-Fetch-Site": "", Origin: "http://deals.example.test" })).status).toBe(403);
  });
});

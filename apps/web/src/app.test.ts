import { afterAll, describe, expect, it, vi } from "vitest";
import { createHarness, TEST_ASSETS, type Harness } from "./testing/harness.js";

// The public parts of web besides sign-in: /healthz and /assets (spec 7.1).

let h: Harness | undefined;

vi.setConfig({ testTimeout: 30_000 });

// Made in the first test rather than in beforeAll, so a failure to build the app shows as that
// test's error.
const harness = async (): Promise<Harness> => (h ??= await createHarness());

afterAll(async () => {
  await h?.db.drop();
});

describe("public routes", () => {
  it("answers GET /healthz with the git SHA, without a session", async () => {
    const response = await (await harness()).app.request("/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sha: "0123456789abcdef0123456789abcdef01234567" });
  });

  it("serves the hashed assets of the manifest as immutable, with their type, and 404 for any other path", async () => {
    const { app } = await harness();
    const styles = await app.request(TEST_ASSETS.styles);

    expect(styles.status).toBe(200);
    expect(styles.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(styles.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(styles.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await styles.text()).toBe(":root{}");

    const missing = await app.request("/assets/manifest.json");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/assets/styles.ffffffffffff.css")).status).toBe(404);
  });

  it("refuses a request body over 64 KB with 413, as Traefik does, also when it comes past Traefik", async () => {
    const browser = (await harness()).browser("198.51.100.70");
    await browser.get("/login");

    const response = await browser.post("/login", { _csrf: "x", email: "a".repeat(65 * 1024) });

    expect(response.status).toBe(413);
  });
});

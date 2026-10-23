import { Hono, type Context } from "hono";
import { describe, expect, it } from "vitest";
import { clearLoginCookie, deviceCookie, loginCookie, sessionCookie, setDeviceCookie, setSessionCookie } from "./cookies.js";

// The Set-Cookie lines one handler writes.
async function cookiesSetBy(handler: (c: Context) => void): Promise<string[]> {
  const app = new Hono();
  app.get("/", (c) => {
    handler(c);
    return c.body(null, 204);
  });
  return (await app.request("/")).headers.getSetCookie();
}

// auth.md 15: every cookie is a __Host- cookie (Secure, Path=/, no Domain) with its own SameSite
// and Max-Age.
describe("web cookies", () => {
  it("sets the session cookie for 7 days, SameSite=Lax (spec 7.4)", async () => {
    expect(await cookiesSetBy((c) => setSessionCookie(c, "session-value"))).toEqual([
      "__Host-jbi_session=session-value; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("sets the device cookie for 180 days, SameSite=Lax (spec 7.5)", async () => {
    expect(await cookiesSetBy((c) => setDeviceCookie(c, "device-value"))).toEqual([
      "__Host-jbi_device=device-value; Max-Age=15552000; Path=/; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("clears the login cookie with Max-Age=0 (spec 7.2)", async () => {
    expect(await cookiesSetBy((c) => clearLoginCookie(c))).toEqual(["__Host-jbi_login=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict"]);
  });

  it("reads back only the __Host- form of each cookie", async () => {
    const app = new Hono();
    // A failure in the handler fails the test with its own message, not as a 500.
    app.onError((error) => {
      throw error;
    });
    app.get("/", (c) => c.json({ login: loginCookie(c) ?? null, session: sessionCookie(c) ?? null, device: deviceCookie(c) ?? null }));
    const read = async (cookie: string) => await (await app.request("/", { headers: { Cookie: cookie } })).json();

    expect(await read("__Host-jbi_login=l; __Host-jbi_session=s; __Host-jbi_device=d")).toEqual({ login: "l", session: "s", device: "d" });
    // A cookie without the prefix could have been set by another *.intra-ai.de site.
    expect(await read("jbi_login=l; jbi_session=s; jbi_device=d")).toEqual({ login: null, session: null, device: null });
  });
});

import { endSession, type DbPool } from "@ebay-sniper/db";
import type { Clock, SettingsEnv } from "@ebay-sniper/domain";
import type { SmtpMailer } from "@ebay-sniper/notify";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { clearSessionCookie, sessionCookie, setThemeCookie } from "./auth/cookies.js";
import type { AuthKeys } from "./auth/keys.js";
import { createOutbox, type Outbox } from "./auth/security-mail.js";
import { tokenHash } from "./auth/tokens.js";
import type { Background, Log } from "./background.js";
import { originCheck } from "./csrf.js";
import { accountRoutes } from "./pages/account/routes.js";
import { errorPage } from "./pages/errors/views.js";
import { loginRoutes } from "./pages/login/routes.js";
import type { ScreeningOption } from "./pages/settings/options.js";
import { mountPages } from "./routes.js";
import { securityHeaders } from "./security.js";
import { sessionGuard, type AppEnv } from "./session.js";
import type { AssetManifest } from "./ui/assets.js";

export type AppDeps = {
  pool: DbPool;
  clock: Clock;
  keys: AuthKeys;
  publicOrigin: string;
  gitSha: string;
  assets: AssetManifest;
  // The bytes of a hashed file under /assets, or null.
  assetFile: (path: string) => Promise<Uint8Array<ArrayBuffer> | null>;
  log: Log;
  background: Background;
  // The noreply mailbox (owner decision 2), or null when LOGIN_SMTP_* is not set.
  mail: { mailer: SmtpMailer; from: string } | null;
  // The .env bounds of the settings (spec 2.5).
  settingsEnv: SettingsEnv;
  // ALERT_TO, shown as the fixed recipient of every product's alerts.
  alertTo: string;
  // The (model, effort) pairs that passed the eval for the current prompt version (spec 4.6).
  screeningOptions: readonly ScreeningOption[];
};

// The kinds of file scripts/build-assets.ts writes.
const ASSET_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  woff2: "font/woff2",
};

// `outbox`: start.ts passes the one the security watch also sends through, so all mail of the
// noreply mailbox shares one send queue.
export function createApp(deps: AppDeps, outbox: Outbox | null = deps.mail === null ? null : createOutbox(deps, deps.mail)): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Spec 7.11's headers go on every response, so this runs first and sets them after the rest
  // answered.
  app.use("*", securityHeaders());
  // The same 64 KB as Traefik, for requests that reach 127.0.0.1:3141 another way.
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("Payload Too Large", 413) }));
  // Spec 7.6 step 2, before anything else: a cross-site POST gets 403 on every route.
  app.use("*", originCheck(deps.publicOrigin));
  app.use("*", sessionGuard(deps));
  // Without an outbox no sign-in mail goes out. Sign-in and security mail share the noreply
  // mailbox and its send queue (spec 7.9).
  app.route("/login", loginRoutes(deps, outbox));

  // Spec 7.1: the deploy checks which release runs. Traefik sends the public /healthz to server,
  // so this one is reached from the host only.
  app.get("/healthz", (c) => c.json({ sha: deps.gitSha }));

  // The hashed files of dist/assets, and only those (assetFile answers null for any other path).
  // securityHeaders marks them immutable.
  app.get("/assets/*", async (c) => {
    const bytes = await deps.assetFile(c.req.path);
    if (bytes === null) return c.notFound();
    return c.body(bytes, 200, { "Content-Type": ASSET_TYPES[c.req.path.split(".").at(-1) ?? ""] ?? "application/octet-stream" });
  });

  // Spec 7.4: the row ends, the cookie goes, and the browser drops its cache and storage. Never
  // "cookies" in Clear-Site-Data: it would sign people out of every *.intra-ai.de site.
  app.post("/logout", async (c) => {
    await endSession(deps.pool, { tokenHash: tokenHash(sessionCookie(c) ?? ""), at: deps.clock.now(), reason: "logout" });
    clearSessionCookie(c);
    c.header("Clear-Site-Data", '"cache", "storage"');
    return c.redirect("/login", 303);
  });
  // Spec 8.1: the toggle posts the other theme and the page it came from. Page scripts ask for JSON and get 204; a plain form goes back to a path on this site.
  app.post("/theme", async (c) => {
    const body = await c.req.parseBody();
    const theme = body["theme"];
    if (theme !== "light" && theme !== "dark") return c.body(null, 400);
    setThemeCookie(c, theme);
    if (c.req.header("accept") === "application/json") return c.body(null, 204);
    const back = typeof body["back"] === "string" ? body["back"] : "/";
    return c.redirect(/^\/(?![/\\])/.test(back) ? back : "/", 303);
  });

  // The person's own sessions (spec 8.3).
  app.route("/account", accountRoutes(deps));
  mountPages(app, deps);
  // Only a signed-in browser gets here: the guard sends everyone else to /login first.
  app.notFound((c) => c.html(errorPage({ status: 404, assets: deps.assets }), 404));
  // By the error's name only: a message can carry an address or a query parameter.
  app.onError((error, c) => {
    deps.log.error({ event: "request_failed", err_name: error.name, method: c.req.method, route: c.req.path });
    return c.html(errorPage({ status: 500, assets: deps.assets }), 500);
  });
  return app;
}

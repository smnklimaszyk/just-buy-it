import { loadSession, type LoadedSession } from "@ebay-sniper/db";
import type { MiddlewareHandler } from "hono";
import type { AppDeps } from "./app.js";
import { sessionCookie } from "./auth/cookies.js";
import { sameSecret, tokenHash } from "./auth/tokens.js";
import { SAFE_METHODS, sentToken } from "./csrf.js";
import { errorPage } from "./pages/errors/views.js";
import { routeGroup } from "./route-groups.js";

// What a request knows once the guard ran: the session, or null on a public route.
export type AppEnv = { Variables: { session: LoadedSession | null } };

// Spec 7.4 step-up: adding, disabling, re-roling a person and ending someone else's sessions need
// a sign-in in the last 15 minutes. Every sign-in makes a new session, so its start counts.
export const STEP_UP_MS = 15 * 60_000;

export const signedInRecently = (session: LoadedSession, at: Date): boolean =>
  at.getTime() - session.session.createdAt.getTime() <= STEP_UP_MS;

// Spec 7.1 and 7.7: everything but the sign-in pages needs a session; GET goes to /login, any
// other method gets 401. People and Activity are for admins; the role is read on every request.
export function sessionGuard(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("session", null);
    const group = routeGroup(c.req.path);
    if (group === "public") return next();
    const token = sessionCookie(c);
    // Spec 7.4: a meta refresh to ?auto=1, or a page script with X-Auto-Refresh: 1, never keeps a
    // session alive.
    const automatic = c.req.query("auto") === "1" || c.req.header("x-auto-refresh") === "1";
    const session = token === undefined ? null : await loadSession(deps.pool, { tokenHash: tokenHash(token), at: deps.clock.now(), automatic });
    if (session === null) return c.req.method === "GET" || c.req.method === "HEAD" ? c.redirect("/login", 303) : c.body(null, 401);
    if (group === "admin" && session.person.role !== "admin") return c.html(errorPage({ status: 403, assets: deps.assets }), 403);
    // Spec 7.6: a state change carries the session's synchronizer token, in the form or, from a
    // page script, in X-CSRF-Token.
    if (!SAFE_METHODS.has(c.req.method) && !sameSecret(await sentToken(c), session.session.csrfSecret)) return c.body(null, 403);
    c.set("session", session);
    return next();
  };
}

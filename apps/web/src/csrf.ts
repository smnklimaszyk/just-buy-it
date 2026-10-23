import type { Context, MiddlewareHandler } from "hono";

// GET never changes state (spec 7.6), so these need no token or origin.
export const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

// Spec 7.6: every request that can change state, on every route and with any content type,
// comes from this site: Sec-Fetch-Site same-origin, or else Origin exactly PUBLIC_ORIGIN. When
// both are missing it is refused. hono/csrf is not enough: it checks form content types only.
export function originCheck(publicOrigin: string): MiddlewareHandler {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    if (c.req.header("sec-fetch-site") === "same-origin" || c.req.header("origin") === publicOrigin) return next();
    return c.body(null, 403);
  };
}

// Spec 7.6. The synchronizer token a request sent: X-CSRF-Token from a page script, else the
// _csrf field of a form post. Forms post application/x-www-form-urlencoded.
export async function sentToken(c: Context): Promise<string> {
  const header = c.req.header("x-csrf-token");
  if (header !== undefined) return header;
  if (!(c.req.header("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) return "";
  const value = (await c.req.parseBody())["_csrf"];
  return typeof value === "string" ? value : "";
}

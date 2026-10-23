import type { MiddlewareHandler } from "hono";

// The eight headers of spec 7.11 and Cache-Control, on every response. HSTS comes from Traefik's hsts-headers, so it is not sent twice.
const HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(HEADERS)) c.res.headers.set(name, value);
    // A hashed asset never changes under its name, so browsers may keep it for a year.
    if (c.req.path.startsWith("/assets/") && c.res.status === 200) c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  };
}

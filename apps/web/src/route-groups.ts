export type RouteGroup = "public" | "session" | "admin";

const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/login", "/login/code", "/healthz"]);

// Spec 7.1: public are the sign-in pages, /healthz and the hashed assets; People and Activity
// are for admins; everything else needs a session.
export function routeGroup(path: string): RouteGroup {
  if (PUBLIC_PATHS.has(path) || path.startsWith("/assets/")) return "public";
  if (/^\/(people|activity)(\/|$)/.test(path)) return "admin";
  return "session";
}

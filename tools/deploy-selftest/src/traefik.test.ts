import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeFile = fileURLToPath(new URL("../../../infra/traefik/ebay-sniper.yml", import.meta.url));

// The lines of one entry under http.routers, http.middlewares or http.services, without its name
// line. Entries sit at four spaces, their settings deeper.
function entry(name: string): string[] {
  const lines = readFileSync(routeFile, "utf8").split("\n");
  const start = lines.indexOf(`    ${name}:`);
  expect(start, `${name} is in the route file`).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {0,4}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter((line) => line.trim() !== "");
}

const serverRule = "      rule: \"Host(`deals.intra-ai.de`) && (Path(`/healthz`) || Path(`/privacy`) || Path(`/ebay/account-deletion`))\"";

describe("infra/traefik/ebay-sniper.yml", () => {
  // Spec 7.10: the deletion endpoint, /healthz and /privacy keep going to server, ahead of the
  // web routers that match the whole host.
  it("keeps the server routers' rule and service and gives them the highest priority, 100", () => {
    for (const name of ["ebay-sniper-http", "ebay-sniper-https"]) {
      const router = entry(name);

      expect(router).toContain(serverRule);
      expect(router).toContain("      service: ebay-sniper");
      expect(router).toContain("      priority: 100");
    }
    expect(entry("ebay-sniper-https")).toEqual(expect.arrayContaining(["        - hsts-headers", "        - ebay-sniper-ratelimit", "        - ebay-sniper-body-limit"]));
  });

  // A sign-in or code POST gets the tight per-IP limit before it reaches web's own counters.
  it("sends POSTs under /login to web at priority 50 with the login rate limit and the body limit", () => {
    const rule = "      rule: \"Host(`deals.intra-ai.de`) && PathPrefix(`/login`) && Method(`POST`)\"";
    const https = entry("ebay-sniper-login-https");

    expect(https).toEqual([
      rule,
      "      priority: 50",
      "      entryPoints:",
      "        - websecure",
      "      service: ebay-sniper-web",
      "      tls:",
      "        certResolver: le",
      "      middlewares:",
      "        - hsts-headers",
      "        - ebay-sniper-login-ratelimit",
      "        - ebay-sniper-body-limit",
    ]);
    expect(entry("ebay-sniper-login-http")).toEqual([
      rule,
      "      priority: 50",
      "      entryPoints:",
      "        - web",
      "      service: ebay-sniper-web",
      "      middlewares:",
      "        - redirect-to-https",
    ]);
    expect(entry("ebay-sniper-login-ratelimit")).toEqual(["      rateLimit:", "        average: 10", "        period: 1m", "        burst: 5"]);
  });

  // Every other path of the host is the admin UI, which sends a browser without a session to /login.
  it("sends the rest of the host to web on 127.0.0.1:3141 at priority 10 with the web rate limit and the body limit", () => {
    const rule = "      rule: \"Host(`deals.intra-ai.de`)\"";

    expect(entry("ebay-sniper-web-https")).toEqual([
      rule,
      "      priority: 10",
      "      entryPoints:",
      "        - websecure",
      "      service: ebay-sniper-web",
      "      tls:",
      "        certResolver: le",
      "      middlewares:",
      "        - hsts-headers",
      "        - ebay-sniper-web-ratelimit",
      "        - ebay-sniper-body-limit",
    ]);
    expect(entry("ebay-sniper-web-http")).toEqual([
      rule,
      "      priority: 10",
      "      entryPoints:",
      "        - web",
      "      service: ebay-sniper-web",
      "      middlewares:",
      "        - redirect-to-https",
    ]);
    expect(entry("ebay-sniper-web-ratelimit")).toEqual(["      rateLimit:", "        average: 20", "        period: 1s", "        burst: 100"]);
    expect(entry("ebay-sniper-web")).toEqual(["      loadBalancer:", "        servers:", '          - url: "http://127.0.0.1:3141"']);
    expect(entry("ebay-sniper")).toEqual(["      loadBalancer:", "        servers:", '          - url: "http://127.0.0.1:3140"']);
  });
});

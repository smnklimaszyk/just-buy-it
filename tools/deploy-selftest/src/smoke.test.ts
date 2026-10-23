import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/host/smoke", import.meta.url));
const run = promisify(execFile);
const sha = "e".repeat(40);

// The headers of spec 7.11 on web's /login and of Release 0 on server's /privacy.
const loginHeaders = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-frame-options": "DENY",
};
const privacyHeaders = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

type SiteOptions = {
  // Paths that answer 200 without a session, as a wrongly routed or unguarded page would.
  open?: string[];
  login?: Record<string, string>;
  privacy?: Record<string, string>;
};

// A stand-in for the public site behind the v2 Traefik file: server answers /healthz, /privacy and
// the deletion endpoint; web answers /login and sends every other path without a session to /login.
function site({ open = [], login = loginHeaders, privacy = privacyHeaders }: SiteOptions = {}): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const reply = (status: number, body = "", headers: Record<string, string> = {}) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    request.resume();
    request.on("end", () => {
      if (open.includes(url.pathname)) return reply(200, "dashboard");
      if (url.pathname === "/healthz") return reply(200, `{"sha":"${sha}"}`);
      if (url.pathname === "/privacy") return reply(200, "privacy", privacy);
      if (url.pathname === "/login") return reply(200, "sign in", login);
      if (url.pathname !== "/ebay/account-deletion") return reply(303, "", { location: "/login" });
      if (request.method === "PUT") return reply(405, "method not allowed");
      if (request.method === "POST") {
        return Number(request.headers["content-length"] ?? 0) > 65_536 ? reply(413) : reply(204);
      }
      if (!url.searchParams.has("challenge_code")) return reply(400);
      return reply(200, '{"challengeResponse":"x"}', { "content-type": "application/json", "cache-control": "no-store" });
    });
  });
}

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// A port nothing listens on: bound once, then released.
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function smoke(port: number, dashboardPort: number) {
  try {
    const { stdout } = await run(script, [`http://127.0.0.1:${port}`, sha], {
      env: { PATH: process.env.PATH ?? "", SMOKE_DASHBOARD_PORT: String(dashboardPort) },
    });
    return { status: 0, output: stdout };
  } catch (error) {
    const failed = error as { code: number; stdout: string };
    return { status: failed.code, output: failed.stdout };
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

describe("smoke", () => {
  it("passes when every page sends a browser without a session to /login and the dashboard port takes no connection", async () => {
    const port = await listen(site());

    const { status, output } = await smoke(port, await closedPort());

    for (const path of ["/", "/products", "/deals", "/settings", "/people", "/candidates", "/alerts", "/prices", "/rejections"]) {
      expect(output).toContain(`ok   ${path} without a session is 303 to /login`);
    }
    expect(output).toMatch(/ok {3}\/smoke-\d+ without a session is 303 to \/login/);
    expect(output).toContain("ok   /login is 200");
    expect(output).toContain("ok   /login has a CSP with default-src 'none' and frame-ancestors 'none'");
    expect(output).toContain("ok   /login has X-Frame-Options: DENY");
    expect(output).toContain("ok   /privacy has a CSP with default-src 'none' and frame-ancestors 'none'");
    expect(output).toContain("ok   challenge is 200 JSON with challengeResponse");
    expect(output).toContain("ok   70 KB POST to /ebay/account-deletion is 413");
    expect(output).toMatch(/ok {3}port \d+ on 127\.0\.0\.1 accepts no connection/);
    expect(output).toContain("all checks passed");
    expect(status).toBe(0);
  });

  it.each<[string, SiteOptions, boolean, string]>([
    ["a page that answers without a session", { open: ["/prices"] }, false, "FAIL /prices without a session is 303 to /login: got '200 '"],
    ["an open dashboard port", {}, true, "accepts no connection: connected in"],
    [
      "a /login without a CSP",
      { login: { "x-frame-options": "DENY" } },
      false,
      "FAIL /login has a CSP with default-src 'none' and frame-ancestors 'none': got 'no CSP header'",
    ],
    [
      "a /login that may be framed",
      { login: { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-frame-options": "SAMEORIGIN" } },
      false,
      "FAIL /login has X-Frame-Options: DENY: got 'x-frame-options: SAMEORIGIN'",
    ],
    [
      "a /privacy with the old dashboard CSP",
      { privacy: { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'" } },
      false,
      "FAIL /privacy has a CSP with default-src 'none' and frame-ancestors 'none': got 'content-security-policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'none''",
    ],
  ])("fails with exit 1 on %s", async (_name, options, dashboardOpen, line) => {
    const port = await listen(site(options));
    const dashboardPort = dashboardOpen ? await listen(site()) : await closedPort();

    const { status, output } = await smoke(port, dashboardPort);

    expect(output).toContain(line);
    expect(output).toContain("1 check(s) failed");
    expect(status).toBe(1);
  });
});

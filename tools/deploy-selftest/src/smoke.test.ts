import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/host/smoke", import.meta.url));
const run = promisify(execFile);
const sha = "e".repeat(40);

// A stand-in for the public site: the answers the existing smoke checks expect, 404 for every
// other path unless it is listed in `open`.
function site(open: string[] = []): Server {
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
      if (url.pathname === "/privacy") return reply(200, "privacy");
      if (url.pathname !== "/ebay/account-deletion") return reply(404);
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
  it("passes when the dashboard paths are 404 and the dashboard port takes no connection", async () => {
    const port = await listen(site());

    const { status, output } = await smoke(port, await closedPort());

    for (const path of ["/candidates", "/alerts", "/prices", "/rejections"]) {
      expect(output).toContain(`ok   ${path} is 404 on the public site`);
    }
    expect(output).toMatch(/ok {3}port \d+ on 127\.0\.0\.1 accepts no connection/);
    expect(output).toContain("all checks passed");
    expect(status).toBe(0);
  });

  it.each([
    ["a public dashboard path", ["/prices"], false, "FAIL /prices is 404 on the public site: got 200"],
    ["an open dashboard port", [], true, "accepts no connection: connected in"],
  ])("fails with exit 1 on %s", async (_name, open, dashboardOpen, line) => {
    const port = await listen(site(open));
    const dashboardPort = dashboardOpen ? await listen(site()) : await closedPort();

    const { status, output } = await smoke(port, dashboardPort);

    expect(output).toContain(line);
    expect(output).toContain("1 check(s) failed");
    expect(status).toBe(1);
  });
});

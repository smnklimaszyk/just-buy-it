import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// main.ts wires the process at import time. These tests replace the pool, the HTTP server and the
// logger with fakes, import it once, and check which pool each listener reads and writes.

type FakePool = {
  options: { connectionString: string; max: number; applicationName: string; statementTimeoutMs?: number };
  statements: string[];
  ended: boolean;
  query: (text: string) => Promise<{ rows: never[]; rowCount: number }>;
  end: () => Promise<void>;
};

type FakeServer = {
  fetch: (request: Request) => Promise<Response>;
  port: number | undefined;
  host: string | undefined;
  closed: boolean;
  listen: (port: number, host: string, callback?: () => void) => FakeServer;
  close: () => void;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
};

const fakes = vi.hoisted(() => ({
  pools: [] as FakePool[],
  servers: [] as FakeServer[],
  signals: new Map<string, () => void>(),
}));

vi.mock("@ebay-sniper/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ebay-sniper/db")>();
  return {
    ...actual,
    createPool: (options: FakePool["options"]) => {
      const pool: FakePool = {
        options,
        statements: [],
        ended: false,
        query: async (text) => {
          pool.statements.push(text);
          return { rows: [], rowCount: 0 };
        },
        end: async () => {
          pool.ended = true;
        },
      };
      fakes.pools.push(pool);
      return pool;
    },
  };
});

vi.mock("@hono/node-server", () => ({
  getRequestListener: (fetch: FakeServer["fetch"]) => fetch,
}));

vi.mock("node:http", () => ({
  createServer: (fetch: FakeServer["fetch"]) => {
    const server: FakeServer = {
      fetch,
      port: undefined,
      host: undefined,
      closed: false,
      listen: (port, host, callback) => {
        server.port = port;
        server.host = host;
        callback?.();
        return server;
      },
      close: () => {
        server.closed = true;
      },
      closeIdleConnections: () => undefined,
      closeAllConnections: () => undefined,
    };
    fakes.servers.push(server);
    return server;
  },
}));

vi.mock("@ebay-sniper/logging", () => ({
  loggerOptions: () => ({}),
  createLogger: () => ({ info: () => undefined, warn: () => undefined, error: () => undefined, flush: () => undefined }),
}));

const env = {
  PORT: "3000",
  EBAY_ENVIRONMENT: "production",
  EBAY_DELETION_ENDPOINT_URL: "https://deals.intra-ai.de/ebay/account-deletion",
  EBAY_DELETION_VERIFICATION_TOKEN: "a".repeat(64),
  EBAY_CLIENT_ID: "",
  EBAY_CLIENT_SECRET: "",
  GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  DATABASE_URL: "postgres://app:apppass@postgres:5432/ebay_sniper",
  DELETION_PROBE_CODE: "Pr0be_code-0123456789abcdefghijABCDEFGHI",
  DASHBOARD_PORT: "3001",
  DASHBOARD_DATABASE_URL: "postgres://dashboard:dashpass@postgres:5432/ebay_sniper",
};

beforeAll(async () => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const realOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM" || event === "SIGINT") {
      fakes.signals.set(event, listener as () => void);
      return process;
    }
    return realOn(event, listener);
  });
  await import("./main.js");
});

afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const poolFor = (url: string): FakePool => {
  const pool = fakes.pools.find((p) => p.options.connectionString === url);
  if (pool === undefined) throw new Error(`no pool for ${url}`);
  return pool;
};

const serverOn = (port: number): FakeServer => {
  const server = fakes.servers.find((s) => s.port === port);
  if (server === undefined) throw new Error(`no listener on ${port}`);
  return server;
};

describe("server wiring", () => {
  it("creates the app pool and a separate two-connection dashboard pool", () => {
    expect(fakes.pools.map((p) => p.options)).toEqual([
      { connectionString: env.DATABASE_URL, max: 3, applicationName: "ebay-sniper-server", onError: expect.any(Function) },
      {
        connectionString: env.DASHBOARD_DATABASE_URL,
        max: 2,
        applicationName: "ebay-sniper-dashboard",
        onError: expect.any(Function),
      },
    ]);
    expect(poolFor(env.DASHBOARD_DATABASE_URL)).toBeDefined();
  });

  it("serves the dashboard on its own listener, reading only through the dashboard pool", async () => {
    const dashboard = serverOn(3001);
    const appPool = poolFor(env.DATABASE_URL);
    const dashboardPool = poolFor(env.DASHBOARD_DATABASE_URL);
    appPool.statements.length = 0;

    const health = await dashboard.fetch(new Request("http://127.0.0.1:3001/healthz"));
    const overview = await dashboard.fetch(new Request("http://127.0.0.1:3001/"));

    expect(dashboard.host).toBe("0.0.0.0");
    expect(await health.text()).toBe(`{"sha":"${env.GIT_SHA}"}`);
    expect(overview.status).toBe(200);
    expect(dashboardPool.statements.some((sql) => sql.includes("app.worker_status"))).toBe(true);
    expect(appPool.statements).toEqual([]);
  });

  it("keeps the dashboard paths off the public listener, whose deletion path writes through the app pool", async () => {
    const publicServer = serverOn(3000);
    const appPool = poolFor(env.DATABASE_URL);
    const dashboardPool = poolFor(env.DASHBOARD_DATABASE_URL);
    dashboardPool.statements.length = 0;

    for (const path of ["/", "/candidates", "/alerts", "/blocked", "/screenings", "/rejections", "/prices"]) {
      expect((await publicServer.fetch(new Request(`https://deals.intra-ai.de${path}`))).status).toBe(404);
    }
    const probe = await publicServer.fetch(
      new Request(`https://deals.intra-ai.de/ebay/account-deletion?challenge_code=${env.DELETION_PROBE_CODE}`),
    );

    expect(probe.status).toBe(200);
    await vi.waitFor(() => expect(appPool.statements.some((sql) => sql.includes("probe_seen"))).toBe(true));
    expect(dashboardPool.statements).toEqual([]);
  });

  // Last: the shutdown closes everything the tests above use.
  it("closes both listeners and ends both pools on SIGTERM", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const shutdown = fakes.signals.get("SIGTERM");

    shutdown?.();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(serverOn(3000).closed).toBe(true);
    expect(serverOn(3001).closed).toBe(true);
    expect(poolFor(env.DATABASE_URL).ended).toBe(true);
    expect(poolFor(env.DASHBOARD_DATABASE_URL).ended).toBe(true);
  });
});

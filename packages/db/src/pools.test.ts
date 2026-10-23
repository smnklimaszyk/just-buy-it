import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { connectionProblem, OPS_CLI_CONNECTIONS, SERVICE_POOLS } from "./pools.js";
import { WORKER_POOL_MAX } from "./queue/registry.js";

// Spec 9.1: every pool that connects to Postgres, plus one ops CLI run, fits into the connections
// Postgres allows (max_connections from compose, minus the 3 reserved for superusers).

const compose = readFileSync(new URL("../../../infra/docker-compose.yml", import.meta.url), "utf8");

function maxConnections(): number {
  const match = /max_connections=(\d+)/.exec(compose);
  if (match?.[1] === undefined) throw new Error("infra/docker-compose.yml sets no max_connections");
  return Number(match[1]);
}

describe("connection budget", () => {
  it("fits the worker pool, pg-boss, server, web and one ops run into max_connections minus 3", () => {
    const pools = { worker: WORKER_POOL_MAX, ...SERVICE_POOLS, ops: OPS_CLI_CONNECTIONS };

    // The MVP dashboard and its pool are gone in v2 (spec 10.4).
    expect(Object.keys(SERVICE_POOLS)).toEqual(["server", "pgBoss", "web"]);
    // v2 adds four worker queues (spec 9.1); 32 leaves one connection of room at the peak.
    expect(maxConnections()).toBe(32);
    expect(connectionProblem(pools, maxConnections())).toBeNull();
  });

  it("names the total and the limit when the pools need one connection more than Postgres allows", () => {
    expect(connectionProblem({ worker: 12, pgBoss: 4, server: 3, web: 4, ops: 3 }, 30)).toBeNull();
    expect(connectionProblem({ worker: 12, pgBoss: 4, server: 3, web: 4, ops: 3, dashboard: 2 }, 30)).toBe(
      "pools need 28 connections, Postgres allows 27 (max_connections 30 - 3 reserved)",
    );
  });
});

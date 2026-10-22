import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/host/live-check", import.meta.url));

// docker ps prints fake-<service> for the worker and postgres services unless the service is in
// $FAKE_MISSING. docker inspect prints $FAKE_WORKER_HEALTH. docker exec answers each psql query by
// the table it reads, from the $FAKE_* value named below, and logs the query. curl answers the
// dashboard /healthz with $FAKE_DASHBOARD_SHA.
const fakes: Record<string, string> = {
  docker: `#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_DIR/log"
case "$1" in
  ps)
    for service in worker postgres; do
      case " $* " in
        *"service=$service "*) case " $FAKE_MISSING " in *" $service "*) ;; *) echo "fake-$service" ;; esac ;;
      esac
    done ;;
  inspect) echo "$FAKE_WORKER_HEALTH" ;;
  exec)
    query="\${*: -1}"
    case "$query" in
      *pgboss.version*) echo "$FAKE_PGBOSS_VERSION" ;;
      *worker_status*) echo "$FAKE_FRESH_HEARTBEATS" ;;
      *app.feed*) echo "$FAKE_FEEDS_BEHIND" ;;
      *poll_run*) echo "$FAKE_STALE_RUNS" ;;
      *listing_content*) echo "$FAKE_OLD_CONTENT" ;;
      *alert_delivery*) echo "$FAKE_LOST_SENDS" ;;
      *llm_usage_daily*) echo "$FAKE_DAYS_OVER_CAP" ;;
      *) echo "fake psql: unexpected query" >&2; exit 2 ;;
    esac ;;
  *) echo "fake docker: unexpected $*" >&2; exit 2 ;;
esac
`,
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_DIR/log"
printf '{"sha":"%s"}' "$FAKE_DASHBOARD_SHA"
`,
};

const sha = "c".repeat(40);

let dir: string;
let root: string;
let fakeDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "live-check-"));
  root = join(dir, "root");
  fakeDir = join(dir, "fake");
  mkdirSync(join(fakeDir, "bin"), { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "running"), `${sha}\n`);
  writeFileSync(join(root, ".env"), "POSTGRES_PASSWORD=00\n");
  writeFileSync(join(fakeDir, "log"), "");
  for (const [name, body] of Object.entries(fakes)) {
    const path = join(fakeDir, "bin", name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function liveCheck(fakeEnv: Record<string, string> = {}) {
  const result = spawnSync(script, [], {
    encoding: "utf8",
    env: {
      PATH: `${join(fakeDir, "bin")}:${process.env.PATH ?? ""}`,
      EBAY_DEPLOY_ROOT: root,
      FAKE_DIR: fakeDir,
      FAKE_MISSING: "",
      FAKE_WORKER_HEALTH: "healthy",
      FAKE_DASHBOARD_SHA: sha,
      FAKE_PGBOSS_VERSION: "46",
      FAKE_FRESH_HEARTBEATS: "1",
      FAKE_FEEDS_BEHIND: "0",
      FAKE_STALE_RUNS: "0",
      FAKE_OLD_CONTENT: "0",
      FAKE_LOST_SENDS: "0",
      FAKE_DAYS_OVER_CAP: "0",
      ...fakeEnv,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("live-check", () => {
  it("passes every check on a healthy host", () => {
    const { status, output } = liveCheck();

    expect(output.split("\n").filter((line) => line.startsWith("ok   "))).toEqual([
      "ok   worker container is healthy",
      `ok   dashboard /healthz reports ${sha}`,
      "ok   pgboss schema version is 46",
      "ok   worker heartbeat under 1 minute old",
      "ok   last poll of every enabled feed is ok and under 15 minutes old",
      "ok   no stale running poll_run row in the last hour",
      "ok   no listing_content row older than 6 h 15 min",
      "ok   no alert_delivery sending past its lease",
      "ok   Claude use today within 40 calls and USD 2",
    ]);
    expect(output).toContain("all checks passed");
    expect(status).toBe(0);
  });

  it.each([
    ["CLAUDE_DAILY_CALL_LIMIT=0\nCLAUDE_DAILY_SPEND_LIMIT_USD=2.50\n", 0, "ok   Claude use today within 0 calls and USD 2.50", "calls > 0 OR"],
    ["CLAUDE_DAILY_CALL_LIMIT=12\n", 0, "ok   Claude use today within 12 calls and USD 2", "> 2 * 1000000"],
    ["CLAUDE_DAILY_CALL_LIMIT=40; DROP TABLE x\n", 1, "FAIL Claude caps in", null],
    ["CLAUDE_DAILY_SPEND_LIMIT_USD=2.555\n", 1, "FAIL Claude caps in", null],
  ])("reads the Claude caps from the .env without sourcing it: %j", (env, exit, line, query) => {
    writeFileSync(join(root, ".env"), `POSTGRES_PASSWORD=00\n${env}`);

    const { status, output } = liveCheck();

    expect(output).toContain(line);
    expect(status).toBe(exit);
    const log = readFileSync(join(fakeDir, "log"), "utf8");
    if (query === null) {
      expect(log).not.toContain("llm_usage_daily");
    } else {
      expect(log).toContain(query);
    }
  });

  it.each([
    [{ FAKE_WORKER_HEALTH: "unhealthy" }, "FAIL worker container is healthy: got 'unhealthy'"],
    [{ FAKE_MISSING: "worker" }, "FAIL worker container is healthy: got 'no worker container'"],
    [{ FAKE_DASHBOARD_SHA: "d".repeat(40) }, `FAIL dashboard /healthz reports ${sha}`],
    [{ FAKE_PGBOSS_VERSION: "45" }, "FAIL pgboss schema version is 46: got '45'"],
    [{ FAKE_FRESH_HEARTBEATS: "0" }, "FAIL worker heartbeat under 1 minute old"],
    [{ FAKE_FEEDS_BEHIND: "1" }, "FAIL last poll of every enabled feed is ok and under 15 minutes old: got '1' feed(s) behind"],
    [{ FAKE_STALE_RUNS: "2" }, "FAIL no stale running poll_run row in the last hour: got '2' stale row(s)"],
    [{ FAKE_OLD_CONTENT: "3" }, "FAIL no listing_content row older than 6 h 15 min: got '3' row(s)"],
    [{ FAKE_LOST_SENDS: "1" }, "FAIL no alert_delivery sending past its lease"],
    [{ FAKE_DAYS_OVER_CAP: "1" }, "FAIL Claude use today within 40 calls and USD 2"],
    [{ FAKE_MISSING: "postgres" }, "FAIL pgboss schema version is 46: got 'no postgres container'"],
  ])("fails with exit 1 and names the check: %j", (fakeEnv, line) => {
    const { status, output } = liveCheck(fakeEnv);

    expect(output).toContain(line);
    expect(output).toMatch(/\d+ check\(s\) failed/);
    expect(status).toBe(1);
  });
});

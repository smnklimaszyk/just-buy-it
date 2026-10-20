import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../infra/host/ebay-deploy", import.meta.url));
const composeFile = fileURLToPath(new URL("../../../infra/docker-compose.yml", import.meta.url));
const envExample = fileURLToPath(new URL("../../../.env.example", import.meta.url));

// Each fake appends "<name> <argv>" to $FAKE_DIR/log. docker records the SHA it started in
// $FAKE_DIR/served; curl answers /healthz with that SHA unless it is listed in $FAKE_BAD_HEALTH.
// curl answers a healthchecks.io ping (an hc-ping URL) with success, or exit 6 when $FAKE_PING_FAIL=1.
// docker fails `build` for SHAs in $FAKE_BUILD_FAIL, the postgres step when $FAKE_POSTGRES_FAIL=1
// and the migrate run with exit $FAKE_MIGRATE_EXIT (default 3) when $FAKE_MIGRATE_FAIL=1. stat
// prints $FAKE_PING_MODE for the ping URL file and $FAKE_ENV_MODE for any other existing file.
// timeout exits 124 without running its command when $FAKE_TIMEOUT=1.
const fakes: Record<string, string> = {
  git: `#!/usr/bin/env bash
echo "git $*" >> "$FAKE_DIR/log"
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  clone) mkdir -p "\${@: -1}/.git" ;;
  fetch) ;;
  merge-base) case " $FAKE_MAIN_SHAS " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac ;;
  archive) tar -C "$FAKE_DIR/tree" -cf - . ;;
  *) echo "fake git: unexpected $*" >&2; exit 2 ;;
esac
`,
  docker: `#!/usr/bin/env bash
echo "docker GIT_SHA=\${GIT_SHA:-} $*" >> "$FAKE_DIR/log"
case "$1" in
  ps) if [ "$FAKE_PS_FAIL" = "1" ]; then exit 1; fi; echo "fake-migrate-container"; exit 0 ;;
  stop) exit 0 ;;
esac
case " $* " in
  *" run "*) if [ "$FAKE_MIGRATE_FAIL" = "1" ]; then exit "\${FAKE_MIGRATE_EXIT:-3}"; fi ;;
  *" build "*) case " $FAKE_BUILD_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac ;;
  *" up "*" postgres ") if [ "$FAKE_POSTGRES_FAIL" = "1" ]; then exit 1; fi ;;
  *" up "*)
    case " $FAKE_COMPOSE_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac
    echo "$GIT_SHA" > "$FAKE_DIR/served" ;;
  *" down"*) rm -f "$FAKE_DIR/served" ;;
esac
`,
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_DIR/log"
case " $* " in
  *hc-ping*)
    if [ "$FAKE_PING_FAIL" = "1" ]; then echo "curl: (6) Could not resolve host: hc-ping.example.test" >&2; exit 6; fi
    exit 0 ;;
esac
[ -f "$FAKE_DIR/served" ] || exit 7
served=$(cat "$FAKE_DIR/served")
case " $FAKE_BAD_HEALTH " in *" $served "*) served=ffffffffffffffffffffffffffffffffffffffff ;; esac
printf '{"sha":"%s"}' "$served"
`,
  flock: `#!/usr/bin/env bash
echo "flock $*" >> "$FAKE_DIR/log"
`,
  sleep: `#!/usr/bin/env bash
`,
  stat: `#!/usr/bin/env bash
echo "stat $*" >> "$FAKE_DIR/log"
file="\${*: -1}"
[ -e "$file" ] || { echo "stat: cannot statx '$file': No such file or directory" >&2; exit 1; }
case "$file" in
  */deploy-ping-url) echo "$FAKE_PING_MODE" ;;
  *) echo "$FAKE_ENV_MODE" ;;
esac
`,
  timeout: `#!/usr/bin/env bash
echo "timeout $*" >> "$FAKE_DIR/log"
if [ "$FAKE_TIMEOUT" = "1" ]; then exit 124; fi
shift
exec "$@"
`,
};

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
// Fixed test values in the formats ebay-deploy requires, not secrets.
const appPassword = "0123456789abcdef".repeat(4);
const probeCode = "Ab0_-".repeat(8);
const validEnv = `POSTGRES_PASSWORD=00\nPOSTGRES_APP_PASSWORD=${appPassword}\nDELETION_PROBE_CODE=${probeCode}\n`;
const pingUrl = "https://hc-ping.example.test/0f3c2a1e-test-check";

let dir: string;
let root: string;
let fakeDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ebay-deploy-"));
  root = join(dir, "root");
  fakeDir = join(dir, "fake");
  mkdirSync(join(fakeDir, "bin"), { recursive: true });
  mkdirSync(join(fakeDir, "tree", "infra"), { recursive: true });
  writeFileSync(join(fakeDir, "tree", "infra", "docker-compose.yml"), "name: ebay-sniper\n");
  writeFileSync(join(fakeDir, "log"), "");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, ".env"), validEnv);
  for (const [name, body] of Object.entries(fakes)) {
    const path = join(fakeDir, "bin", name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deploy(sha: string, fakeEnv: Record<string, string> = {}) {
  const result = spawnSync(script, [sha], {
    encoding: "utf8",
    env: {
      PATH: `${join(fakeDir, "bin")}:${process.env.PATH ?? ""}`,
      EBAY_DEPLOY_ROOT: root,
      EBAY_DEPLOY_HEALTH_URL: "https://deals.example.test/healthz",
      FAKE_DIR: fakeDir,
      FAKE_MAIN_SHAS: "",
      FAKE_COMPOSE_FAIL: "",
      FAKE_BAD_HEALTH: "",
      FAKE_ENV_MODE: "root:root 600",
      FAKE_PING_MODE: "root:root 600",
      ...fakeEnv,
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function calls(tool: string): string[] {
  return readFileSync(join(fakeDir, "log"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith(`${tool} `));
}

function writePingFile(content = `${pingUrl}\n`) {
  writeFileSync(join(root, "deploy-ping-url"), content);
}

// The healthchecks.io pings, as the URL each curl call sent.
function pings(): string[] {
  return calls("curl")
    .filter((line) => line.includes("hc-ping"))
    .map((line) => {
      expect(line).toMatch(/^curl -fsS --max-time 10 --retry 2 -o \/dev\/null \S+$/);
      return line.split(" ").at(-1) ?? "";
    });
}

function runningIs(sha: string) {
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "state", "running"), `${sha}\n`);
}

// The lines of one top-level service in the compose file, without its name line.
function composeService(name: string): string[] {
  const lines = readFileSync(composeFile, "utf8").split("\n");
  const start = lines.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start + 1, end);
}

// The keys of a service's environment map.
function environmentKeys(service: string[]): string[] {
  const start = service.indexOf("    environment:");
  expect(start).toBeGreaterThan(-1);
  const keys: string[] = [];
  for (const line of service.slice(start + 1)) {
    if (/^ {6}#/.test(line)) continue;
    const match = /^ {6}([A-Z_]+):/.exec(line);
    if (!match?.[1]) break;
    keys.push(match[1]);
  }
  return keys;
}

describe("ebay-deploy", () => {
  it.each(["", "abc", "A".repeat(40), `${shaA}0`, "main"])("refuses an argument that is not a full SHA: '%s'", (arg) => {
    const { status, output } = deploy(arg);

    expect(status).not.toBe(0);
    expect(output).toMatch(/usage: ebay-deploy <40-character commit sha>/);
    expect(calls("git")).toEqual([]);
    expect(calls("docker")).toEqual([]);
  });

  it("clones the repo on first run and refuses a SHA that is not on main without touching docker", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaA });

    expect(status).toBe(1);
    expect(output).toContain(`${shaB} is not on origin/main`);
    expect(calls("git")).toEqual([
      `git clone --quiet https://github.com/smnklimaszyk/just-buy-it.git ${root}/repo`,
      `git -C ${root}/repo fetch --quiet origin main`,
      `git -C ${root}/repo merge-base --is-ancestor ${shaB} origin/main`,
    ]);
    expect(calls("docker")).toEqual([]);
    expect(existsSync(join(root, "releases", shaB))).toBe(false);
  });

  it("refuses a .env that is not root:root 600 before any docker call", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_ENV_MODE: "root:root 644" });

    expect(status).toBe(1);
    expect(output).toContain(".env must be root:root 600");
    expect(calls("docker")).toEqual([]);
  });

  it("refuses a missing .env before any docker call", () => {
    rmSync(join(root, ".env"));

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(".env must be root:root 600");
    expect(calls("docker")).toEqual([]);
  });

  it.each(["OTHER=1\n", "POSTGRES_PASSWORD=\n", "POSTGRES_PASSWORD=p@ss/word\n", "POSTGRES_PASSWORD=ABCDEF\n"])(
    "refuses a .env without a lowercase hex POSTGRES_PASSWORD before any docker call: %j",
    (env) => {
      writeFileSync(join(root, ".env"), env);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${root}/.env must set POSTGRES_PASSWORD to a lowercase hex value`);
      expect(calls("docker")).toEqual([]);
    },
  );

  it.each([
    "",
    "POSTGRES_APP_PASSWORD=\n",
    `POSTGRES_APP_PASSWORD=${appPassword.slice(1)}\n`,
    `POSTGRES_APP_PASSWORD=${appPassword}0\n`,
    `POSTGRES_APP_PASSWORD=${appPassword.toUpperCase()}\n`,
    `POSTGRES_APP_PASSWORD="${appPassword}"\n`,
  ])("refuses a .env without a 64-character hex POSTGRES_APP_PASSWORD before any docker call: %j", (line) => {
    writeFileSync(join(root, ".env"), `POSTGRES_PASSWORD=00\n${line}DELETION_PROBE_CODE=${probeCode}\n`);
    writePingFile();

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`${root}/.env must set POSTGRES_APP_PASSWORD to 64 lowercase hex characters`);
    expect(output).toContain("openssl rand -hex 32");
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it.each([
    "",
    "DELETION_PROBE_CODE=\n",
    `DELETION_PROBE_CODE=${probeCode.slice(1)}\n`,
    `DELETION_PROBE_CODE=${probeCode}A\n`,
    `DELETION_PROBE_CODE=${probeCode.slice(2)}+/\n`,
    `DELETION_PROBE_CODE=${probeCode.slice(1)}=\n`,
  ])("refuses a .env without a 40-character DELETION_PROBE_CODE before any docker call: %j", (line) => {
    writeFileSync(join(root, ".env"), `POSTGRES_PASSWORD=00\nPOSTGRES_APP_PASSWORD=${appPassword}\n${line}`);
    writePingFile();

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`${root}/.env must set DELETION_PROBE_CODE to 40 characters of [A-Za-z0-9_-]`);
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("exits 0 without git or docker when the SHA is already running", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);

    const { status, output } = deploy(shaA, { FAKE_MAIN_SHAS: shaA });

    expect(status).toBe(0);
    expect(output).toContain(`${shaA} is already running`);
    expect(calls("git")).toEqual([]);
    expect(calls("docker")).toEqual([]);
  });

  it("starts the new release, records running and previous, and keeps five releases plus previous", () => {
    const old = ["1", "2", "3", "4", "5", "6", "7"].map((digit) => digit.repeat(40));
    old.forEach((oldSha, index) => {
      const release = join(root, "releases", oldSha);
      mkdirSync(release, { recursive: true });
      const time = new Date(Date.UTC(2026, 9, 1 + index));
      utimesSync(release, time, time);
    });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${old[0]}\n`);
    writeFileSync(join(fakeDir, "served"), `${old[0]}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(output).toContain(`${shaB} is live`);
    expect(calls("docker").at(-1)).toBe(
      `docker GIT_SHA=${shaB} compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120 server`,
    );
    expect(calls("curl")[0]).toContain("https://deals.example.test/healthz");
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
    expect(readFileSync(join(root, "state", "previous"), "utf8").trim()).toBe(old[0]);
    expect(existsSync(join(root, "releases", shaB, "infra", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(root, "releases", shaB, ".git"))).toBe(false);
    expect(readdirSync(join(root, "releases")).sort()).toEqual([old[0], old[3], old[4], old[5], old[6], shaB].sort());
  });

  it("builds, applies the postgres config, migrates and then starts only the server, each with the .env file", () => {
    const compose = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml`;

    const { status } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} ${compose} build server`,
      `docker GIT_SHA=${shaB} ${compose} up -d --wait --wait-timeout 120 postgres`,
      `docker GIT_SHA=${shaB} ${compose} run --rm --no-deps -T migrate`,
      `docker GIT_SHA=${shaB} ${compose} up -d --build --wait --wait-timeout 120 server`,
    ]);
  });

  it("logs the postgres and migrate steps", () => {
    const { output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(output).toContain(`ebay-deploy: postgres: applying the config of ${shaB}`);
    expect(output).toContain(`ebay-deploy: migrate: running the migrations of ${shaB}`);
  });

  it("runs migrate under timeout 900", () => {
    const { status } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(calls("timeout")).toEqual([
      `timeout 900 env GIT_SHA=${shaB} docker compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml run --rm --no-deps -T migrate`,
    ]);
  });

  it("stops after a failed build without the postgres step, migrate or up", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BUILD_FAIL: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`build of ${shaB} failed, the running release is unchanged`);
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml build server`,
    ]);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
  });

  it("stops when postgres does not get healthy, without migrate or the server up", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_POSTGRES_FAIL: "1" });

    expect(status).toBe(1);
    expect(output).toContain(`postgres for ${shaB} is not healthy, the server still runs the old release`);
    expect(calls("docker").map((line) => line.split(" ").slice(-1)[0])).toEqual(["server", "postgres"]);
    expect(calls("timeout")).toEqual([]);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
  });

  it("stops when migrate fails, with the exit code, without the server up or a rollback", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_MIGRATE_FAIL: "1" });

    expect(status).toBe(1);
    expect(output).toContain(`migration for ${shaB} failed (exit 3), the running release is unchanged`);
    expect(calls("docker").map((line) => line.split(" ").slice(-1)[0])).toEqual(["server", "postgres", "migrate"]);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
  });

  it("stops the leftover migrate container and the deploy when migrate times out", () => {
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_TIMEOUT: "1" });

    expect(status).toBe(1);
    expect(output).toContain(`migration for ${shaB} timed out after 900 s, the running release is unchanged`);
    expect(calls("docker").slice(2)).toEqual([
      "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=migrate --filter label=com.docker.compose.oneoff=True",
      "docker GIT_SHA= stop fake-migrate-container",
    ]);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
  });

  it("still reports the migrate timeout when the leftover container cannot be listed", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_TIMEOUT: "1", FAKE_PS_FAIL: "1" });

    expect(status).toBe(1);
    expect(output).toContain("could not stop the leftover migrate container");
    expect(output).toContain(`migration for ${shaB} timed out after 900 s`);
    expect(calls("docker").filter((line) => line.includes(" up -d --build "))).toEqual([]);
  });

  it("rolls back to the running release when /healthz does not report the new SHA", () => {
    mkdirSync(join(root, "releases", shaA, "infra"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);
    writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_HEALTH: shaB });

    expect(status).toBe(1);
    const composeB = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml`;
    const composeA = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaA}/infra/docker-compose.yml`;
    expect(output).toContain(`rolled back to ${shaA}`);
    // The rollback starts the old release without a postgres step or a migrate run.
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} ${composeB} build server`,
      `docker GIT_SHA=${shaB} ${composeB} up -d --wait --wait-timeout 120 postgres`,
      `docker GIT_SHA=${shaB} ${composeB} run --rm --no-deps -T migrate`,
      `docker GIT_SHA=${shaB} ${composeB} up -d --build --wait --wait-timeout 120 server`,
      `docker GIT_SHA=${shaA} ${composeA} up -d --build --wait --wait-timeout 120 server`,
    ]);
    expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaA);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
    expect(existsSync(join(root, "state", "previous"))).toBe(false);
  });

  it("stops the new containers when the first deploy fails and there is nothing to roll back to", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_COMPOSE_FAIL: shaB });

    expect(status).toBe(1);
    expect(output).toContain("no previous release, stopped the new containers");
    // down without -v keeps the Postgres volume.
    expect(calls("docker").slice(-2)).toEqual([
      `docker GIT_SHA=${shaB} compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120 server`,
      "docker GIT_SHA= compose -p ebay-sniper down",
    ]);
    expect(existsSync(join(root, "state", "running"))).toBe(false);
  });

  describe("healthchecks.io deploy pings", () => {
    it("deploys as before without pings when there is no ping URL file", () => {
      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(0);
      expect(output).toContain("ebay-deploy: no deploy ping URL, skipping healthchecks.io pings");
      expect(output).toContain(`${shaB} is live`);
      expect(pings()).toEqual([]);
    });

    it("sends /start and then the success ping on a successful deploy", () => {
      writePingFile();

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(0);
      expect(output).toContain(`${shaB} is live`);
      expect(output).not.toContain("no deploy ping URL");
      expect(pings()).toEqual([`${pingUrl}/start`, pingUrl]);
    });

    it("sends /start before the first docker call and the success ping after the server is up", () => {
      writePingFile();

      deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      const log = readFileSync(join(fakeDir, "log"), "utf8").split("\n");
      const start = log.findIndex((line) => line.endsWith(`${pingUrl}/start`));
      const firstDocker = log.findIndex((line) => line.startsWith("docker "));
      const lastUp = log.findLastIndex((line) => line.includes(" up -d --build "));
      const success = log.findIndex((line) => line.endsWith(` ${pingUrl}`));
      expect(start).toBeGreaterThan(-1);
      expect(start).toBeLessThan(firstDocker);
      expect(success).toBeGreaterThan(lastUp);
    });

    it.each([
      ["a failed build", { FAKE_BUILD_FAIL: shaB }],
      ["an unhealthy postgres", { FAKE_POSTGRES_FAIL: "1" }],
      ["a migrate timeout", { FAKE_TIMEOUT: "1" }],
    ])("sends /start and then /fail after %s", (_name, fakeEnv) => {
      writePingFile();
      runningIs(shaA);

      const { status } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, ...fakeEnv });

      expect(status).toBe(1);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("sends /fail and keeps the old server when the migrate step fails the app role check (exit 1)", () => {
      writePingFile();
      runningIs(shaA);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_MIGRATE_FAIL: "1", FAKE_MIGRATE_EXIT: "1" });

      expect(status).toBe(1);
      expect(output).toContain(`migration for ${shaB} failed (exit 1), the running release is unchanged`);
      expect(calls("docker").filter((line) => line.includes(" up -d --build "))).toEqual([]);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("sends /fail after a successful rollback, since the deploy of the new SHA failed", () => {
      writePingFile();
      mkdirSync(join(root, "releases", shaA, "infra"), { recursive: true });
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_HEALTH: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`rolled back to ${shaA}`);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("sends /fail when the first deploy fails and there is nothing to roll back to", () => {
      writePingFile();

      const { status } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_COMPOSE_FAIL: shaB });

      expect(status).toBe(1);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("sends no ping when the SHA is already running", () => {
      writePingFile();
      runningIs(shaA);

      const { status } = deploy(shaA, { FAKE_MAIN_SHAS: shaA });

      expect(status).toBe(0);
      expect(pings()).toEqual([]);
    });

    it.each([
      ["a SHA that is not on main", { FAKE_MAIN_SHAS: shaA }],
      ["a .env that is not root:root 600", { FAKE_MAIN_SHAS: shaB, FAKE_ENV_MODE: "root:root 644" }],
    ])("sends no ping when it refuses %s", (_name, fakeEnv) => {
      writePingFile();

      const { status } = deploy(shaB, fakeEnv);

      expect(status).toBe(1);
      expect(pings()).toEqual([]);
    });

    it.each(["root:root 644", "root:root 640", "ebay:root 600"])(
      "refuses a ping URL file with owner and mode %s before any docker call",
      (mode) => {
        writePingFile();

        const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_PING_MODE: mode });

        expect(status).toBe(1);
        expect(output).toContain(`${root}/deploy-ping-url must be root:root 600`);
        expect(calls("docker")).toEqual([]);
        expect(pings()).toEqual([]);
      },
    );

    it.each([
      "",
      "\n",
      "http://hc-ping.example.test/0f3c2a1e-test-check\n",
      "https://\n",
      `${pingUrl} extra\n`,
      `${pingUrl}\n${pingUrl}\n`,
    ])("refuses a ping URL file that does not hold one https URL before any docker call: %j", (content) => {
      writePingFile(content);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${root}/deploy-ping-url must hold one https:// URL on one line`);
      expect(calls("docker")).toEqual([]);
      expect(pings()).toEqual([]);
    });

    it("keeps exit 0 when the pings fail, with a warning that does not show the URL", () => {
      writePingFile();

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_PING_FAIL: "1" });

      expect(status).toBe(0);
      expect(output).toContain(`${shaB} is live`);
      expect(output).toContain("ebay-deploy: warning: the healthchecks.io start ping failed");
      expect(output).toContain("ebay-deploy: warning: the healthchecks.io success ping failed");
      expect(output).not.toContain("0f3c2a1e");
      expect(pings()).toEqual([`${pingUrl}/start`, pingUrl]);
    });

    it("keeps exit 1 and the failure message when the /fail ping fails", () => {
      writePingFile();
      runningIs(shaA);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_MIGRATE_FAIL: "1", FAKE_PING_FAIL: "1" });

      expect(status).toBe(1);
      expect(output).toContain(`migration for ${shaB} failed (exit 3), the running release is unchanged`);
      expect(output).toContain("ebay-deploy: warning: the healthchecks.io fail ping failed");
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });
  });
});

describe("docker-compose.yml", () => {
  it("gives the server 15 s to stop: 10 s drain, 2 s flush, 1 s pool end, hard stop at 14 s", () => {
    expect(composeService("server")).toContain("    stop_grace_period: 15s");
  });

  it("passes the server an explicit variable list instead of the whole .env", () => {
    const server = composeService("server");

    expect(server.some((line) => line.includes("env_file"))).toBe(false);
    expect(environmentKeys(server)).toEqual([
      "PORT",
      "TZ",
      "EBAY_ENVIRONMENT",
      "EBAY_DELETION_ENDPOINT_URL",
      "EBAY_DELETION_VERIFICATION_TOKEN",
      "EBAY_CLIENT_ID",
      "EBAY_CLIENT_SECRET",
      "DELETION_PROBE_CODE",
      "DATABASE_URL",
    ]);
    expect(server.join("\n")).not.toContain("${POSTGRES_PASSWORD");
  });

  it("connects the server as the app role and requires its password and the probe code", () => {
    const server = composeService("server").join("\n");

    expect(server).toContain(
      "      DATABASE_URL: postgres://app:${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}@postgres:5432/ebay_sniper",
    );
    expect(server).toContain("      DELETION_PROBE_CODE: ${DELETION_PROBE_CODE:?DELETION_PROBE_CODE is required}");
    expect(server).toContain("      EBAY_CLIENT_ID: ${EBAY_CLIENT_ID:-}");
    expect(server).toContain("      EBAY_CLIENT_SECRET: ${EBAY_CLIENT_SECRET:-}");
    for (const name of ["EBAY_ENVIRONMENT", "EBAY_DELETION_ENDPOINT_URL", "EBAY_DELETION_VERIFICATION_TOKEN"]) {
      expect(server).toContain(`      ${name}: \${${name}:?${name} is required}`);
    }
  });

  it("keeps the server free of depends_on, so it answers while Postgres is down", () => {
    expect(composeService("server").some((line) => line.trim().startsWith("depends_on"))).toBe(false);
  });

  it("gives the migrate service the owner URL and the app role password", () => {
    const migrate = composeService("migrate");

    expect(environmentKeys(migrate)).toEqual(["DATABASE_URL", "POSTGRES_APP_PASSWORD", "TZ"]);
    expect(migrate).toContain(
      "      DATABASE_URL: postgres://ebay_sniper:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/ebay_sniper",
    );
    expect(migrate).toContain("      POSTGRES_APP_PASSWORD: ${POSTGRES_APP_PASSWORD:?POSTGRES_APP_PASSWORD is required}");
  });
});

describe(".env.example", () => {
  it("lists every variable the compose file reads from .env, except GIT_SHA", () => {
    const read = new Set([...readFileSync(composeFile, "utf8").matchAll(/\$\{([A-Z_]+)/g)].map((match) => match[1]));
    read.delete("GIT_SHA");
    const listed = [...readFileSync(envExample, "utf8").matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]);

    expect([...read].sort()).toEqual([...new Set(listed)].sort());
  });

  it("puts one comment line above each new value", () => {
    const lines = readFileSync(envExample, "utf8").split("\n");
    for (const name of ["POSTGRES_APP_PASSWORD", "DELETION_PROBE_CODE"]) {
      const index = lines.indexOf(`${name}=`);
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).toMatch(/^# /);
    }
  });
});

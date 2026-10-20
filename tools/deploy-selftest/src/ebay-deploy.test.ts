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

// Each fake appends "<name> <argv>" to $FAKE_DIR/log. docker records the SHA it started in
// $FAKE_DIR/served; curl answers /healthz with that SHA unless it is listed in $FAKE_BAD_HEALTH.
// docker fails `build` for SHAs in $FAKE_BUILD_FAIL, the postgres step when $FAKE_POSTGRES_FAIL=1
// and the migrate run with exit 3 when $FAKE_MIGRATE_FAIL=1. stat prints $FAKE_ENV_MODE for an
// existing file. timeout exits 124 without running its command when $FAKE_TIMEOUT=1.
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
  *" run "*) if [ "$FAKE_MIGRATE_FAIL" = "1" ]; then exit 3; fi ;;
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
echo "$FAKE_ENV_MODE"
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
  writeFileSync(join(root, ".env"), "POSTGRES_PASSWORD=00\n");
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
});

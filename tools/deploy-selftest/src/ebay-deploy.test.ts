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
const fakes: Record<string, string> = {
  git: `#!/usr/bin/env bash
echo "git $*" >> "$FAKE_DIR/log"
if [ "$1" = "-C" ]; then shift 2; fi
case "$1" in
  clone) mkdir -p "$3/.git" ;;
  fetch) ;;
  merge-base) case " $FAKE_MAIN_SHAS " in *" $3 "*) exit 0 ;; *) exit 1 ;; esac ;;
  archive) tar -C "$FAKE_DIR/tree" -cf - . ;;
  *) echo "fake git: unexpected $*" >&2; exit 2 ;;
esac
`,
  docker: `#!/usr/bin/env bash
echo "docker GIT_SHA=\${GIT_SHA:-} $*" >> "$FAKE_DIR/log"
case " $* " in
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
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} compose -p ebay-sniper -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120`,
    ]);
    expect(calls("curl")[0]).toContain("https://deals.example.test/healthz");
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
    expect(readFileSync(join(root, "state", "previous"), "utf8").trim()).toBe(old[0]);
    expect(existsSync(join(root, "releases", shaB, "infra", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(root, "releases", shaB, ".git"))).toBe(false);
    expect(readdirSync(join(root, "releases")).sort()).toEqual([old[0], old[3], old[4], old[5], old[6], shaB].sort());
  });

  it("rolls back to the running release when /healthz does not report the new SHA", () => {
    mkdirSync(join(root, "releases", shaA, "infra"), { recursive: true });
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(join(root, "state", "running"), `${shaA}\n`);
    writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_HEALTH: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`rolled back to ${shaA}`);
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} compose -p ebay-sniper -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120`,
      `docker GIT_SHA=${shaA} compose -p ebay-sniper -f ${root}/releases/${shaA}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120`,
    ]);
    expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaA);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
    expect(existsSync(join(root, "state", "previous"))).toBe(false);
  });

  it("stops the new containers when the first deploy fails and there is nothing to roll back to", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_COMPOSE_FAIL: shaB });

    expect(status).toBe(1);
    expect(output).toContain("no previous release, stopped the new containers");
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} compose -p ebay-sniper -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120`,
      "docker GIT_SHA= compose -p ebay-sniper down",
    ]);
    expect(existsSync(join(root, "state", "running"))).toBe(false);
  });
});

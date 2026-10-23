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
// timeout exits 124 without running its command when $FAKE_TIMEOUT=1. `config --services` prints
// the top-level services of the -f file and fails when the file is missing. `up ... worker` fails
// for SHAs in $FAKE_WORKER_FAIL and otherwise records the SHA in $FAKE_DIR/worker. `up ... web`
// fails for SHAs in $FAKE_WEB_FAIL and otherwise records the SHA in $FAKE_DIR/web; curl answers
// the web /healthz on 127.0.0.1:3141 with that SHA unless it is listed in $FAKE_BAD_WEB_HEALTH.
// `stop` of the fake worker or web container removes its file.
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
  ps)
    if [ "$FAKE_PS_FAIL" = "1" ]; then exit 1; fi
    case " $* " in
      *service=worker*) echo "fake-worker-container" ;;
      *service=web*) echo "fake-web-container" ;;
      *) echo "fake-migrate-container" ;;
    esac
    exit 0 ;;
  stop)
    case "$2" in
      fake-worker-container) rm -f "$FAKE_DIR/worker" ;;
      fake-web-container) rm -f "$FAKE_DIR/web" ;;
    esac
    exit 0 ;;
esac
case " $* " in
  *" config --services "*)
    file=""; prev=""
    for arg in "$@"; do [ "$prev" = "-f" ] && file="$arg"; prev="$arg"; done
    [ -f "$file" ] || exit 1
    sed -n 's/^  \\([a-z][a-z-]*\\):$/\\1/p' "$file"
    exit 0 ;;
  *" up "*" worker ")
    case " $FAKE_WORKER_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac
    echo "$GIT_SHA" > "$FAKE_DIR/worker" ;;
  *" up "*" web ")
    case " $FAKE_WEB_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac
    echo "$GIT_SHA" > "$FAKE_DIR/web" ;;
  *" run "*) if [ "$FAKE_MIGRATE_FAIL" = "1" ]; then exit "\${FAKE_MIGRATE_EXIT:-3}"; fi ;;
  *" build "*) case " $FAKE_BUILD_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac ;;
  *" up "*" postgres ") if [ "$FAKE_POSTGRES_FAIL" = "1" ]; then exit 1; fi ;;
  *" up "*)
    case " $FAKE_COMPOSE_FAIL " in *" $GIT_SHA "*) exit 1 ;; esac
    echo "$GIT_SHA" > "$FAKE_DIR/served" ;;
  *" down"*) rm -f "$FAKE_DIR/served" "$FAKE_DIR/worker" "$FAKE_DIR/web" ;;
esac
`,
  curl: `#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_DIR/log"
case " $* " in
  *hc-ping*)
    if [ "$FAKE_PING_FAIL" = "1" ]; then echo "curl: (6) Could not resolve host: hc-ping.example.test" >&2; exit 6; fi
    exit 0 ;;
  *127.0.0.1:3141/healthz*)
    [ -f "$FAKE_DIR/web" ] || exit 7
    web=$(cat "$FAKE_DIR/web")
    case " $FAKE_BAD_WEB_HEALTH " in *" $web "*) web=ffffffffffffffffffffffffffffffffffffffff ;; esac
    printf '{"sha":"%s"}' "$web"
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
const workerPassword = "fedcba9876543210".repeat(4);
const dashboardPassword = "00112233445566778899aabbccddeeff".repeat(2);
const webPassword = "0f1e2d3c4b5a6978".repeat(4);
// 32 bytes in base64, as `openssl rand -base64 32` prints them.
const itemKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const authKey = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU=";
const baseEnvLines = [
  "POSTGRES_PASSWORD=00",
  `POSTGRES_APP_PASSWORD=${appPassword}`,
  `DELETION_PROBE_CODE=${probeCode}`,
  `POSTGRES_WORKER_PASSWORD=${workerPassword}`,
  `POSTGRES_DASHBOARD_PASSWORD=${dashboardPassword}`,
  `POSTGRES_WEB_PASSWORD=${webPassword}`,
  `ITEM_KEY_V1=${itemKey}`,
  `AUTH_KEY=${authKey}`,
  "AUTH_BOOTSTRAP_ADMINS=admin@example.test",
  "PUBLIC_ORIGIN=https://deals.intra-ai.de",
];
const validEnv = `${baseEnvLines.join("\n")}\n`;
// ALERT_FROM as on the host: an unquoted display name with the address.
const smtpLines = [
  "SMTP_HOST=mail.example.test",
  "SMTP_PORT=587",
  "SMTP_USER=alerts@example.test",
  "SMTP_PASSWORD=not-a-real-password",
  "ALERT_FROM=Just-Buy-It <alerts@example.test>",
];
// The sign-in mailbox, separate from the alert mailbox (ADR 0038).
const loginSmtpLines = [
  "LOGIN_SMTP_HOST=mail.example.test",
  "LOGIN_SMTP_PORT=587",
  "LOGIN_SMTP_USER=noreply@example.test",
  "LOGIN_SMTP_PASSWORD=not-a-real-login-password",
  "LOGIN_FROM=Just-Buy-It <noreply@example.test>",
];
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

// A release tree whose compose file defines a worker service, as Release 0.
function withWorker(tree: string) {
  mkdirSync(join(tree, "infra"), { recursive: true });
  writeFileSync(join(tree, "infra", "docker-compose.yml"), "name: ebay-sniper\nservices:\n  server:\n  worker:\n");
}

// A release tree with the worker and the web service, as v2.
function withWeb(tree: string) {
  mkdirSync(join(tree, "infra"), { recursive: true });
  writeFileSync(join(tree, "infra", "docker-compose.yml"), "name: ebay-sniper\nservices:\n  server:\n  worker:\n  web:\n");
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
    const match = /^ {6}([A-Z0-9_]+):/.exec(line);
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

  it.each([
    ["POSTGRES_WORKER_PASSWORD", ""],
    ["POSTGRES_WORKER_PASSWORD", "POSTGRES_WORKER_PASSWORD=\n"],
    ["POSTGRES_WORKER_PASSWORD", `POSTGRES_WORKER_PASSWORD=${workerPassword.slice(1)}\n`],
    ["POSTGRES_WORKER_PASSWORD", `POSTGRES_WORKER_PASSWORD=${workerPassword.toUpperCase()}\n`],
    ["POSTGRES_DASHBOARD_PASSWORD", ""],
    ["POSTGRES_DASHBOARD_PASSWORD", `POSTGRES_DASHBOARD_PASSWORD=${dashboardPassword}0\n`],
    ["POSTGRES_DASHBOARD_PASSWORD", `POSTGRES_DASHBOARD_PASSWORD="${dashboardPassword}"\n`],
    ["POSTGRES_WEB_PASSWORD", `POSTGRES_WEB_PASSWORD=${webPassword.slice(1)}\n`],
  ])("refuses a .env without a 64-character hex %s before any docker call: %j", (name, line) => {
    const others = baseEnvLines.filter((other) => !other.startsWith(`${name}=`));
    writeFileSync(join(root, ".env"), `${others.join("\n")}\n${line}`);
    writePingFile();

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`${root}/.env must set ${name} to 64 lowercase hex characters (openssl rand -hex 32)`);
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it.each([
    "",
    "ITEM_KEY_V1=\n",
    `ITEM_KEY_V1=${itemKey.slice(1)}\n`,
    `ITEM_KEY_V1=${itemKey.slice(0, -1)}\n`,
    `ITEM_KEY_V1=${itemKey}A\n`,
    `ITEM_KEY_V1=${itemKey.slice(0, -2)}-=\n`,
  ])("refuses a .env without a 44-character base64 ITEM_KEY_V1 before any docker call: %j", (line) => {
    const others = baseEnvLines.filter((other) => !other.startsWith("ITEM_KEY_V1="));
    writeFileSync(join(root, ".env"), `${others.join("\n")}\n${line}`);
    writePingFile();

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`${root}/.env must set ITEM_KEY_V1 to 44 base64 characters (openssl rand -base64 32)`);
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("refuses a .env without a 44-character base64 AUTH_KEY before any docker call, without printing the key", () => {
    const others = baseEnvLines.filter((other) => !other.startsWith("AUTH_KEY="));
    writePingFile();
    for (const line of ["", "AUTH_KEY=\n", `AUTH_KEY=${authKey.slice(1)}\n`, `AUTH_KEY=${authKey}A\n`, `AUTH_KEY="${authKey}"\n`]) {
      writeFileSync(join(root, ".env"), `${others.join("\n")}\n${line}`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${root}/.env must set AUTH_KEY to 44 base64 characters (openssl rand -base64 32)`);
      expect(output).not.toContain(authKey.slice(1, -1));
    }
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("refuses a .env without a comma list of addresses in AUTH_BOOTSTRAP_ADMINS before any docker call", () => {
    const others = baseEnvLines.filter((other) => !other.startsWith("AUTH_BOOTSTRAP_ADMINS="));
    writePingFile();
    for (const value of [
      null,
      "",
      "simon",
      "admin@example.test,",
      "admin@example.test,,editor@example.test",
      "admin@example.test, editor@example.test",
      "admin@@example.test",
      '"admin@example.test"',
    ]) {
      const line = value === null ? "" : `AUTH_BOOTSTRAP_ADMINS=${value}\n`;
      writeFileSync(join(root, ".env"), `${others.join("\n")}\n${line}`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status, value ?? "no line").toBe(1);
      expect(output).toContain(`${root}/.env must set AUTH_BOOTSTRAP_ADMINS to one or more addresses, separated by commas without spaces`);
    }
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("deploys with two bootstrap admins", () => {
    const others = baseEnvLines.filter((other) => !other.startsWith("AUTH_BOOTSTRAP_ADMINS="));
    writeFileSync(join(root, ".env"), `${others.join("\n")}\nAUTH_BOOTSTRAP_ADMINS=admin@example.test,second.admin@example.test\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(output).toContain(`${shaB} is live`);
  });

  // The web service compares the Origin header with it exactly (spec 7.6), and the route file only
  // serves deals.intra-ai.de, so any other value breaks every form post (ADR 0029, v2 additions).
  it("refuses a .env whose PUBLIC_ORIGIN is not exactly https://deals.intra-ai.de before any docker call", () => {
    const others = baseEnvLines.filter((other) => !other.startsWith("PUBLIC_ORIGIN="));
    writePingFile();
    for (const value of [
      null,
      "",
      "http://deals.intra-ai.de",
      "https://deals.intra-ai.de/",
      "https://deals.intra-ai.de/login",
      "https://Deals.intra-ai.de",
      "https://deals.intra-ai.de:443",
      "https://deals.intra-ai.com",
      "deals.intra-ai.de",
      '"https://deals.intra-ai.de"',
    ]) {
      const line = value === null ? "" : `PUBLIC_ORIGIN=${value}\n`;
      writeFileSync(join(root, ".env"), `${others.join("\n")}\n${line}`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status, value ?? "no line").toBe(1);
      expect(output).toContain(`${root}/.env must set PUBLIC_ORIGIN=https://deals.intra-ai.de exactly, without a path or a trailing slash`);
    }
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it.each([
    [["SMTP_HOST"], "SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_FROM"],
    [["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"], "ALERT_FROM"],
    [["SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "ALERT_FROM"], "SMTP_HOST"],
    [["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "ALERT_FROM="], "ALERT_FROM"],
  ])("refuses a partial SMTP set %j before any docker call, naming the missing variables", (names, missing) => {
    // A name listed with "=" is written with an empty value, which counts as absent.
    const smtp = names.map((name) => (name.endsWith("=") ? name : smtpLines.find((line) => line.startsWith(`${name}=`))));
    writeFileSync(join(root, ".env"), `${validEnv}${smtp.join("\n")}\n`);
    writePingFile();

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(1);
    expect(output).toContain(`${root}/.env sets SMTP partially, missing ${missing} (set all five or none)`);
    expect(output).not.toContain("not-a-real-password");
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("refuses a partial LOGIN_SMTP set before any docker call, naming the missing variables", () => {
    writePingFile();
    // A name ending in "=" is written with an empty value, which counts as absent.
    for (const [names, missing] of [
      [["LOGIN_SMTP_HOST"], "LOGIN_SMTP_PORT, LOGIN_SMTP_USER, LOGIN_SMTP_PASSWORD, LOGIN_FROM"],
      [["LOGIN_SMTP_HOST", "LOGIN_SMTP_PORT", "LOGIN_SMTP_USER", "LOGIN_SMTP_PASSWORD"], "LOGIN_FROM"],
      [["LOGIN_SMTP_HOST", "LOGIN_SMTP_PORT", "LOGIN_SMTP_USER", "LOGIN_FROM", "LOGIN_SMTP_PASSWORD="], "LOGIN_SMTP_PASSWORD"],
    ] as const) {
      const smtp = names.map((name) => (name.endsWith("=") ? name : loginSmtpLines.find((line) => line.startsWith(`${name}=`))));
      writeFileSync(join(root, ".env"), `${validEnv}${smtp.join("\n")}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${root}/.env sets LOGIN_SMTP partially, missing ${missing} (set all five or none)`);
      expect(output).not.toContain("not-a-real-login-password");
    }
    expect(calls("docker")).toEqual([]);
    expect(pings()).toEqual([]);
  });

  it("deploys with all five LOGIN_SMTP values next to the five alert SMTP values", () => {
    writeFileSync(join(root, ".env"), `${validEnv}${[...smtpLines, ...loginSmtpLines].join("\n")}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(output).toContain(`${shaB} is live`);
  });

  it.each([
    ["all five SMTP values", smtpLines.join("\n")],
    ["no SMTP value", ""],
    ["five empty SMTP values", "SMTP_HOST=\nSMTP_PORT=\nSMTP_USER=\nSMTP_PASSWORD=\nALERT_FROM="],
  ])("deploys with %s", (_name, smtp) => {
    writeFileSync(join(root, ".env"), `${validEnv}${smtp}\n`);

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    expect(output).toContain(`${shaB} is live`);
  });

  // Spec 10.4: the model is the claude.model setting now; the worker ignores the old variable.
  it("warns about a leftover CLAUDE_MODEL without refusing, and stays quiet for an empty one", () => {
    writeFileSync(join(root, ".env"), `${validEnv}CLAUDE_MODEL=claude-sonnet-5-5\n`);

    const set = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(set.status).toBe(0);
    expect(set.output).toContain(
      `ebay-deploy: warning: ${root}/.env still sets CLAUDE_MODEL, which nothing reads since the model became the claude.model setting; remove the line`,
    );
    expect(set.output).toContain(`${shaB} is live`);

    writeFileSync(join(root, ".env"), `${validEnv}CLAUDE_MODEL=\n`);
    const empty = deploy(shaA, { FAKE_MAIN_SHAS: shaA });

    expect(empty.status).toBe(0);
    expect(empty.output).not.toContain("CLAUDE_MODEL");
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
    expect(calls("docker").find((line) => line.includes(" up -d --build "))).toBe(
      `docker GIT_SHA=${shaB} compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml up -d --build --wait --wait-timeout 120 server`,
    );
    expect(calls("curl")[0]).toContain("https://deals.example.test/healthz");
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
    expect(readFileSync(join(root, "state", "previous"), "utf8").trim()).toBe(old[0]);
    expect(existsSync(join(root, "releases", shaB, "infra", "docker-compose.yml"))).toBe(true);
    expect(existsSync(join(root, "releases", shaB, ".git"))).toBe(false);
    expect(readdirSync(join(root, "releases")).sort()).toEqual([old[0], old[3], old[4], old[5], old[6], shaB].sort());
  });

  it("builds, applies the postgres config, migrates and then starts only the server of a release without a worker", () => {
    const compose = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml`;

    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

    expect(status).toBe(0);
    // A worker left by a newer release (a rollback by hand to an older SHA) must not keep polling
    // eBay and sending email next to the older server.
    expect(output).toContain(`${shaB} has no worker, stopping the worker container`);
    // The same for a web service left by a v2 release.
    expect(output).toContain(`${shaB} has no web service, stopping the web container`);
    expect(calls("docker")).toEqual([
      `docker GIT_SHA=${shaB} ${compose} build server`,
      `docker GIT_SHA=${shaB} ${compose} up -d --wait --wait-timeout 120 postgres`,
      `docker GIT_SHA=${shaB} ${compose} run --rm --no-deps -T migrate`,
      `docker GIT_SHA=${shaB} ${compose} up -d --build --wait --wait-timeout 120 server`,
      `docker GIT_SHA=${shaB} ${compose} config --services`,
      "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=web",
      "docker GIT_SHA= stop fake-web-container",
      `docker GIT_SHA=${shaB} ${compose} config --services`,
      "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=worker",
      "docker GIT_SHA= stop fake-worker-container",
    ]);
    expect(existsSync(join(fakeDir, "worker"))).toBe(false);
    expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
  });

  it("goes live with a warning when the worker container of a release without a worker cannot be stopped", () => {
    const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_PS_FAIL: "1" });

    expect(status).toBe(0);
    expect(output).toContain("could not stop the web container, check docker ps");
    expect(output).toContain("could not stop the worker container, check docker ps");
    expect(output).toContain(`${shaB} is live`);
  });

  describe("worker", () => {
    it("starts the server first, checks it, then starts the worker with its own health wait", () => {
      withWorker(join(fakeDir, "tree"));
      const compose = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaB}/infra/docker-compose.yml`;

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(0);
      expect(output).toContain(`${shaB} is live`);
      expect(calls("docker")).toEqual([
        `docker GIT_SHA=${shaB} ${compose} build server`,
        `docker GIT_SHA=${shaB} ${compose} up -d --wait --wait-timeout 120 postgres`,
        `docker GIT_SHA=${shaB} ${compose} run --rm --no-deps -T migrate`,
        `docker GIT_SHA=${shaB} ${compose} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaB} ${compose} config --services`,
        "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=web",
        "docker GIT_SHA= stop fake-web-container",
        `docker GIT_SHA=${shaB} ${compose} config --services`,
        `docker GIT_SHA=${shaB} ${compose} up -d --no-deps --wait --wait-timeout 90 worker`,
      ]);
      const log = readFileSync(join(fakeDir, "log"), "utf8").split("\n");
      const healthz = log.findIndex((line) => line.startsWith("curl ") && line.includes("/healthz"));
      const workerUp = log.findIndex((line) => line.endsWith(" worker"));
      expect(healthz).toBeGreaterThan(-1);
      expect(healthz).toBeLessThan(workerUp);
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaB);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
    });

    it("rolls back the server, web and the worker to the previous release when the worker does not get healthy", () => {
      withWeb(join(fakeDir, "tree"));
      withWeb(join(root, "releases", shaA));
      writePingFile();
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);
      const composeA = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaA}/infra/docker-compose.yml`;

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WORKER_FAIL: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`the worker of ${shaB} did not get healthy within 90 s`);
      expect(output).toContain(`deploy of ${shaB} failed, rolled back to ${shaA}`);
      expect(calls("docker").slice(-5)).toEqual([
        `docker GIT_SHA=${shaA} ${composeA} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaA} ${composeA} config --services`,
        `docker GIT_SHA=${shaA} ${composeA} up -d --no-deps --wait --wait-timeout 60 web`,
        `docker GIT_SHA=${shaA} ${composeA} config --services`,
        `docker GIT_SHA=${shaA} ${composeA} up -d --no-deps --wait --wait-timeout 90 worker`,
      ]);
      expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(fakeDir, "web"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
      expect(existsSync(join(root, "state", "previous"))).toBe(false);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("rolls back only the server and never starts the new worker when the new server fails", () => {
      withWorker(join(fakeDir, "tree"));
      withWorker(join(root, "releases", shaA));
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_HEALTH: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`deploy of ${shaB} failed, rolled back to ${shaA}`);
      expect(calls("docker").filter((line) => line.includes("worker") || line.includes("config --services"))).toEqual([]);
      expect(existsSync(join(fakeDir, "worker"))).toBe(false);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
    });

    it("rolls back the server and stops the web and worker containers when the previous release has neither", () => {
      withWeb(join(fakeDir, "tree"));
      mkdirSync(join(root, "releases", shaA, "infra"), { recursive: true });
      writeFileSync(join(root, "releases", shaA, "infra", "docker-compose.yml"), "name: ebay-sniper\nservices:\n  server:\n");
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);
      const composeA = `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${shaA}/infra/docker-compose.yml`;

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WORKER_FAIL: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${shaA} has no web service, stopping the web container`);
      expect(output).toContain(`${shaA} has no worker, stopping the worker container`);
      expect(output).toContain(`deploy of ${shaB} failed, rolled back to ${shaA}`);
      expect(calls("docker").slice(-7)).toEqual([
        `docker GIT_SHA=${shaA} ${composeA} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaA} ${composeA} config --services`,
        "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=web",
        "docker GIT_SHA= stop fake-web-container",
        `docker GIT_SHA=${shaA} ${composeA} config --services`,
        "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=worker",
        "docker GIT_SHA= stop fake-worker-container",
      ]);
      expect(existsSync(join(fakeDir, "web"))).toBe(false);
      expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
    });

    it("stops the new containers when the worker of a first deploy does not get healthy", () => {
      withWorker(join(fakeDir, "tree"));

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WORKER_FAIL: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`the worker of ${shaB} did not get healthy within 90 s`);
      expect(output).toContain("no previous release, stopped the new containers");
      expect(calls("docker").at(-1)).toBe("docker GIT_SHA= compose -p ebay-sniper down");
      expect(existsSync(join(root, "state", "running"))).toBe(false);
    });

    it("reports a failed rollback when the previous worker does not get healthy either", () => {
      withWorker(join(fakeDir, "tree"));
      withWorker(join(root, "releases", shaA));
      writePingFile();
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WORKER_FAIL: `${shaB} ${shaA}` });

      expect(status).toBe(1);
      expect(output).toContain(`deploy of ${shaB} failed and the rollback to ${shaA} failed too, check the host now`);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });
  });

  describe("web", () => {
    const composeOf = (sha: string) =>
      `compose -p ebay-sniper --env-file ${root}/.env -f ${root}/releases/${sha}/infra/docker-compose.yml`;

    it("starts web after the server, checks its SHA on 127.0.0.1:3141, then starts the worker", () => {
      withWeb(join(fakeDir, "tree"));

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status, output).toBe(0);
      expect(output).toContain(`${shaB} is live`);
      expect(calls("docker").slice(3)).toEqual([
        `docker GIT_SHA=${shaB} ${composeOf(shaB)} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaB} ${composeOf(shaB)} config --services`,
        `docker GIT_SHA=${shaB} ${composeOf(shaB)} up -d --no-deps --wait --wait-timeout 60 web`,
        `docker GIT_SHA=${shaB} ${composeOf(shaB)} config --services`,
        `docker GIT_SHA=${shaB} ${composeOf(shaB)} up -d --no-deps --wait --wait-timeout 90 worker`,
      ]);
      const log = readFileSync(join(fakeDir, "log"), "utf8").split("\n");
      const publicHealth = log.findIndex((line) => line.startsWith("curl ") && line.includes("deals.example.test/healthz"));
      const webUp = log.findIndex((line) => line.endsWith(" web"));
      const webHealth = log.findIndex((line) => line === "curl -fsS --max-time 2 http://127.0.0.1:3141/healthz");
      const workerUp = log.findIndex((line) => line.endsWith(" worker"));
      expect(publicHealth).toBeGreaterThan(-1);
      expect(publicHealth).toBeLessThan(webUp);
      expect(webUp).toBeLessThan(webHealth);
      expect(webHealth).toBeLessThan(workerUp);
      expect(readFileSync(join(fakeDir, "web"), "utf8").trim()).toBe(shaB);
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaB);
    });

    it("rolls back the server and web together when the new web /healthz does not report the SHA, without touching the worker", () => {
      withWeb(join(fakeDir, "tree"));
      withWeb(join(root, "releases", shaA));
      writePingFile();
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);
      writeFileSync(join(fakeDir, "web"), `${shaA}\n`);
      writeFileSync(join(fakeDir, "worker"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_WEB_HEALTH: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`the web service of ${shaB} did not get healthy or did not report its SHA within 60 s`);
      expect(output).toContain(`deploy of ${shaB} failed, rolled back to ${shaA}`);
      expect(calls("docker").slice(-3)).toEqual([
        `docker GIT_SHA=${shaA} ${composeOf(shaA)} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaA} ${composeOf(shaA)} config --services`,
        `docker GIT_SHA=${shaA} ${composeOf(shaA)} up -d --no-deps --wait --wait-timeout 60 web`,
      ]);
      expect(calls("docker").filter((line) => line.endsWith(" worker"))).toEqual([]);
      expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(fakeDir, "web"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });

    it("rolls back to Release 0 by stopping web when the new web does not get healthy and the running release has no web", () => {
      withWeb(join(fakeDir, "tree"));
      withWorker(join(root, "releases", shaA));
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);
      writeFileSync(join(fakeDir, "worker"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WEB_FAIL: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`${shaA} has no web service, stopping the web container`);
      expect(output).toContain(`deploy of ${shaB} failed, rolled back to ${shaA}`);
      expect(calls("docker").slice(-4)).toEqual([
        `docker GIT_SHA=${shaA} ${composeOf(shaA)} up -d --build --wait --wait-timeout 120 server`,
        `docker GIT_SHA=${shaA} ${composeOf(shaA)} config --services`,
        "docker GIT_SHA= ps -q --filter label=com.docker.compose.project=ebay-sniper --filter label=com.docker.compose.service=web",
        "docker GIT_SHA= stop fake-web-container",
      ]);
      // Release 0's worker kept running throughout.
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaA);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
    });

    // Spec 11.6: `ebay-deploy <sha R0>` is the rollback from v2.
    it("stops web and starts the older worker when it deploys a release without web over a v2 release", () => {
      withWorker(join(fakeDir, "tree"));
      withWeb(join(root, "releases", shaA));
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);
      writeFileSync(join(fakeDir, "web"), `${shaA}\n`);
      writeFileSync(join(fakeDir, "worker"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB });

      expect(status).toBe(0);
      expect(output).toContain(`${shaB} has no web service, stopping the web container`);
      expect(output).toContain(`${shaB} is live`);
      expect(existsSync(join(fakeDir, "web"))).toBe(false);
      expect(readFileSync(join(fakeDir, "served"), "utf8").trim()).toBe(shaB);
      expect(readFileSync(join(fakeDir, "worker"), "utf8").trim()).toBe(shaB);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaB);
      expect(readFileSync(join(root, "state", "previous"), "utf8").trim()).toBe(shaA);
    });

    it("stops the new containers when web of a first deploy does not get healthy", () => {
      withWeb(join(fakeDir, "tree"));

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_WEB_FAIL: shaB });

      expect(status).toBe(1);
      expect(output).toContain(`the web service of ${shaB} did not get healthy or did not report its SHA within 60 s`);
      expect(output).toContain("no previous release, stopped the new containers");
      expect(calls("docker").at(-1)).toBe("docker GIT_SHA= compose -p ebay-sniper down");
      expect(calls("docker").filter((line) => line.endsWith(" worker"))).toEqual([]);
      expect(existsSync(join(root, "state", "running"))).toBe(false);
    });

    it("reports a failed rollback when the previous web does not come back either", () => {
      withWeb(join(fakeDir, "tree"));
      withWeb(join(root, "releases", shaA));
      writePingFile();
      runningIs(shaA);
      writeFileSync(join(fakeDir, "served"), `${shaA}\n`);

      const { status, output } = deploy(shaB, { FAKE_MAIN_SHAS: shaB, FAKE_BAD_WEB_HEALTH: `${shaB} ${shaA}` });

      expect(status).toBe(1);
      expect(output).toContain(`deploy of ${shaB} failed and the rollback to ${shaA} failed too, check the host now`);
      expect(readFileSync(join(root, "state", "running"), "utf8").trim()).toBe(shaA);
      expect(pings()).toEqual([`${pingUrl}/start`, `${pingUrl}/fail`]);
    });
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

  // Spec 10.4: the web service replaces the old dashboard; its listener, its two variables and
  // its port 3142 are gone.
  it("publishes only 127.0.0.1:3140 for the server, no longer the dashboard port 3142", () => {
    const server = composeService("server");

    expect(server.join("\n")).not.toContain("DASHBOARD");
    const start = server.indexOf("    ports:");
    expect(server[start + 1]).toBe('      - "127.0.0.1:3140:3000"');
    expect(server[start + 2]).not.toMatch(/^ {6}- /);
    expect(readFileSync(composeFile, "utf8")).not.toContain("3142");
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

  it("runs the worker from the server image with an explicit variable list, as the worker role", () => {
    const worker = composeService("worker");
    const text = worker.join("\n");

    expect(worker).toContain("    image: ebay-sniper-server:${GIT_SHA:?GIT_SHA is required}");
    expect(worker).toContain("    working_dir: /app/apps/worker");
    expect(worker).toContain('    command: ["node", "dist/main.js"]');
    expect(worker.some((line) => line.includes("env_file") || line.trim().startsWith("build:"))).toBe(false);
    expect(environmentKeys(worker)).toEqual([
      "TZ",
      "DATABASE_URL",
      "DB_STATEMENT_TIMEOUT_MS",
      "EBAY_ENVIRONMENT",
      "EBAY_CLIENT_ID",
      "EBAY_CLIENT_SECRET",
      "EBAY_ENDUSERCTX_POSTAL_CODE",
      "ITEM_KEY_V1",
      "BUYER_PROFILE",
      "ANTHROPIC_API_KEY",
      "CLAUDE_DAILY_CALL_LIMIT",
      "CLAUDE_DAILY_SPEND_LIMIT_USD",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "ALERT_FROM",
      "ALERT_TO",
      "LOG_LEVEL",
      "NODE_OPTIONS",
    ]);
    expect(worker).toContain(
      "      DATABASE_URL: postgres://worker:${POSTGRES_WORKER_PASSWORD:?POSTGRES_WORKER_PASSWORD is required}@postgres:5432/ebay_sniper",
    );
    for (const name of ["EBAY_ENVIRONMENT", "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "ITEM_KEY_V1", "ALERT_TO"]) {
      expect(worker).toContain(`      ${name}: \${${name}:?${name} is required}`);
    }
    for (const name of ["ANTHROPIC_API_KEY", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "ALERT_FROM"]) {
      expect(worker).toContain(`      ${name}: \${${name}:-}`);
    }
    // CLAUDE_MODEL: the model is the claude.model setting (spec 10.4). The rest are other services'.
    for (const other of [
      "${POSTGRES_PASSWORD",
      "POSTGRES_APP_PASSWORD",
      "POSTGRES_DASHBOARD_PASSWORD",
      "POSTGRES_WEB_PASSWORD",
      "DELETION_",
      "CLAUDE_MODEL",
      "AUTH_KEY",
      "LOGIN_SMTP",
    ]) {
      expect(text).not.toContain(other);
    }
  });

  it("hardens the worker, waits for healthy Postgres and checks the heartbeat file every 10 s", () => {
    const worker = composeService("worker");

    expect(worker.some((line) => line.trim().startsWith("ports:"))).toBe(false);
    for (const line of [
      "    read_only: true",
      "      - /tmp",
      "      - ALL",
      "      - no-new-privileges:true",
      "    mem_limit: 256m",
      // V8 collects harder before the heap reaches mem_limit, instead of a kernel OOM kill.
      "      NODE_OPTIONS: --max-old-space-size=160",
      "    stop_grace_period: 75s",
      "    restart: unless-stopped",
      "        condition: service_healthy",
      '      test: ["CMD-SHELL", "test $$(( $$(date +%s) - $$(stat -c %Y /tmp/worker-alive) )) -lt 30"]',
      "      interval: 10s",
      "      timeout: 3s",
      "      retries: 3",
      "      start_period: 30s",
      "        max-size: 10m",
      '        max-file: "3"',
    ]) {
      expect(worker).toContain(line);
    }
  });

  // Spec 7.1 and 9.1: the admin UI and sign-in, as role web, with the secrets it needs and no other.
  it("runs web from the server image with an explicit variable list, as the web role", () => {
    const web = composeService("web");
    const text = web.join("\n");

    expect(web).toContain("    image: ebay-sniper-server:${GIT_SHA:?GIT_SHA is required}");
    expect(web).toContain("    working_dir: /app/apps/web");
    expect(web).toContain('    command: ["node", "dist/main.js"]');
    expect(web.some((line) => line.includes("env_file") || line.trim().startsWith("build:"))).toBe(false);
    expect(environmentKeys(web)).toEqual([
      "PORT",
      "TZ",
      "DATABASE_URL",
      "AUTH_KEY",
      "PUBLIC_ORIGIN",
      "ALERT_TO",
      "BUYER_PROFILE",
      "CLAUDE_DAILY_CALL_LIMIT",
      "CLAUDE_DAILY_SPEND_LIMIT_USD",
      "LOGIN_SMTP_HOST",
      "LOGIN_SMTP_PORT",
      "LOGIN_SMTP_USER",
      "LOGIN_SMTP_PASSWORD",
      "LOGIN_FROM",
      "LOG_LEVEL",
      "NODE_OPTIONS",
    ]);
    expect(web).toContain('      PORT: "3000"');
    expect(web).toContain(
      "      DATABASE_URL: postgres://web:${POSTGRES_WEB_PASSWORD:?POSTGRES_WEB_PASSWORD is required}@postgres:5432/ebay_sniper",
    );
    for (const name of ["AUTH_KEY", "PUBLIC_ORIGIN", "ALERT_TO"]) {
      expect(web).toContain(`      ${name}: \${${name}:?${name} is required}`);
    }
    for (const name of ["CLAUDE_DAILY_CALL_LIMIT", "CLAUDE_DAILY_SPEND_LIMIT_USD", "LOGIN_SMTP_HOST", "LOGIN_SMTP_PASSWORD", "LOGIN_FROM"]) {
      expect(web).toContain(`      ${name}: \${${name}:-}`);
    }
    // Never the owner, another role's password, the alert mailbox, Claude, eBay or the item key.
    for (const other of [
      "${POSTGRES_PASSWORD",
      "POSTGRES_APP_PASSWORD",
      "POSTGRES_WORKER_PASSWORD",
      "POSTGRES_DASHBOARD_PASSWORD",
      "${SMTP_",
      "ALERT_FROM",
      "ANTHROPIC_API_KEY",
      "EBAY_",
      "ITEM_KEY_V1",
      "DELETION_",
    ]) {
      expect(text).not.toContain(other);
    }
  });

  it("publishes web on 127.0.0.1:3141 only, hardens it and checks its /healthz", () => {
    const web = composeService("web");

    const start = web.indexOf("    ports:");
    expect(start).toBeGreaterThan(-1);
    expect(web[start + 1]).toBe('      - "127.0.0.1:3141:3000"');
    expect(web[start + 2]).not.toMatch(/^ {6}- /);
    for (const line of [
      "    read_only: true",
      "      - /tmp",
      "      - ALL",
      "      - no-new-privileges:true",
      "    mem_limit: 192m",
      "      NODE_OPTIONS: --max-old-space-size=115",
      "    restart: unless-stopped",
      "        condition: service_healthy",
      '      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]',
      "      interval: 10s",
      "      timeout: 3s",
      "      retries: 3",
      "      start_period: 20s",
      // SIGTERM: running requests and queued sign-in mail finish (two 10 s tries 30 s apart).
      "    stop_grace_period: 60s",
      "        max-size: 10m",
      '        max-file: "3"',
    ]) {
      expect(web).toContain(line);
    }
  });

  // The ops CLI runs in this service too (runbook section 0): products and settings need the
  // Claude ceilings, `ops auth code` and `ops auth unlock` the sign-in key.
  it("gives the migrate service the owner URL, the role passwords, the bootstrap admins and what the ops CLI reads", () => {
    const migrate = composeService("migrate");

    expect(environmentKeys(migrate)).toEqual([
      "DATABASE_URL",
      "POSTGRES_APP_PASSWORD",
      "POSTGRES_WORKER_PASSWORD",
      "POSTGRES_DASHBOARD_PASSWORD",
      "POSTGRES_WEB_PASSWORD",
      "AUTH_BOOTSTRAP_ADMINS",
      "AUTH_KEY",
      "CLAUDE_DAILY_CALL_LIMIT",
      "CLAUDE_DAILY_SPEND_LIMIT_USD",
      "BUYER_PROFILE",
      "TZ",
    ]);
    expect(migrate).toContain(
      "      DATABASE_URL: postgres://ebay_sniper:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/ebay_sniper",
    );
    for (const name of ["POSTGRES_APP_PASSWORD", "POSTGRES_WEB_PASSWORD", "AUTH_BOOTSTRAP_ADMINS", "AUTH_KEY"]) {
      expect(migrate).toContain(`      ${name}: \${${name}:?${name} is required}`);
    }
    for (const name of ["CLAUDE_DAILY_CALL_LIMIT", "CLAUDE_DAILY_SPEND_LIMIT_USD", "BUYER_PROFILE"]) {
      expect(migrate).toContain(`      ${name}: \${${name}:-}`);
    }
  });
});

describe(".env.example", () => {
  it("lists every variable the compose file reads from .env, except GIT_SHA", () => {
    const read = new Set([...readFileSync(composeFile, "utf8").matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]));
    read.delete("GIT_SHA");
    const listed = [...readFileSync(envExample, "utf8").matchAll(/^([A-Z0-9_]+)=/gm)].map((match) => match[1]);

    expect([...read].sort()).toEqual([...new Set(listed)].sort());
  });

  it("puts one comment line above each new value", () => {
    const lines = readFileSync(envExample, "utf8").split("\n");
    for (const name of [
      "POSTGRES_APP_PASSWORD",
      "DELETION_PROBE_CODE",
      "POSTGRES_WORKER_PASSWORD",
      "POSTGRES_DASHBOARD_PASSWORD",
      "ITEM_KEY_V1",
      "ANTHROPIC_API_KEY",
      "SMTP_HOST",
      "ALERT_TO",
      "POSTGRES_WEB_PASSWORD",
      "AUTH_KEY",
      "AUTH_BOOTSTRAP_ADMINS",
      "PUBLIC_ORIGIN",
      "LOGIN_SMTP_HOST",
      "LOGIN_FROM",
    ]) {
      const index = lines.findIndex((line) => line.startsWith(`${name}=`));
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).toMatch(/^# /);
    }
  });
});

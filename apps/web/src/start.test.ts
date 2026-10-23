import { createPool, RoleCheckError, type DbPool } from "@ebay-sniper/db";
import { PROMPT_VERSION, worstCaseCostMicrousd } from "@ebay-sniper/llm/catalog";
import { describe, expect, it, vi } from "vitest";
import type { WebEnv } from "./env.js";
import { passedScreeningOptions, runWeb, type WebRuntime } from "./start.js";
import { createTestClock, createTestLog } from "./testing/fakes.js";
import { START, TEST_ASSETS, TEST_AUTH_KEY } from "./testing/harness.js";

// The web process from start to shutdown, with fakes for the database, the HTTP server, the
// timers and the signals.

const ENV: WebEnv = {
  port: 3000,
  databaseUrl: "postgres://web:unused@127.0.0.1:1/unused",
  gitSha: "0123456789abcdef0123456789abcdef01234567",
  authKey: TEST_AUTH_KEY,
  publicOrigin: "https://deals.example.test",
  loginSmtp: null,
  settingsEnv: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null },
  alertTo: "owner@example.test",
  logLevel: "info",
};

function fakeRuntime() {
  const steps: string[] = [];
  const testLog = createTestLog();
  let serve: ((request: Request) => Response | Promise<Response>) | undefined;
  let pool: DbPool | undefined;
  const runtime: WebRuntime = {
    env: ENV,
    clock: createTestClock(START),
    log: { ...testLog.log, flush: () => steps.push("flush") },
    checkRole: async (url) => {
      steps.push(`check role ${url}`);
    },
    // A real pool that never connects: nothing listens on port 1.
    createPool: (url) => {
      steps.push(`pool ${url}`);
      pool = createPool({ connectionString: url, max: 1, applicationName: "web-start-test", onError: () => undefined });
      return pool;
    },
    readManifest: async () => TEST_ASSETS,
    assetFile: async () => null,
    createMailer: () => {
      throw new Error("no mailbox in this test");
    },
    listen: (fetch, port) => {
      steps.push(`listen ${port}`);
      serve = fetch;
      return {
        close: async () => {
          steps.push("server close");
        },
      };
    },
    every: (ms) => {
      steps.push(`every ${ms}`);
      return { stop: () => void steps.push("timer stop") };
    },
    onSignal: () => undefined,
    exit: (code) => void steps.push(`exit ${code}`),
  };
  return { runtime, steps, testLog, serve: (request: Request) => serve?.(request), pool: () => pool };
}

describe("passedScreeningOptions", () => {
  it("offers Settings only the pairs that passed the eval for the current prompt, each with its worst case (spec 4.6)", () => {
    const evals = [
      { model: "claude-sonnet-5-5", effort: "medium", promptVersion: PROMPT_VERSION, passedOn: "2026-10-23" },
      { model: "claude-haiku-5-5", effort: "medium", promptVersion: "screen-v1:000000000000", passedOn: "2026-10-01" },
    ] as const;

    expect(passedScreeningOptions(evals)).toEqual([
      { model: "claude-sonnet-5-5", effort: "medium", passedOn: "2026-10-23", worstCaseMicrousd: worstCaseCostMicrousd("claude-sonnet-5-5") },
    ]);
  });
});

describe("runWeb", () => {
  it("checks the web role before it opens the pool and listens, then serves the app on PORT", async () => {
    const { runtime, steps, serve } = fakeRuntime();

    await runWeb(runtime);

    expect(steps.slice(0, 3)).toEqual([`check role ${ENV.databaseUrl}`, `pool ${ENV.databaseUrl}`, "listen 3000"]);
    const health = await serve(new Request("http://localhost/healthz"));
    expect(await health?.json()).toEqual({ sha: ENV.gitSha });
  });

  it("with a sign-in mailbox, runs the security mail watch every minute and logs a failed scan by its name", async () => {
    const { runtime, steps, testLog } = fakeRuntime();
    let task: (() => Promise<void>) | undefined;
    runtime.env = { ...ENV, loginSmtp: { host: "smtp.test", port: 587, user: "noreply@intra-ai.de", password: "p", from: { name: "", address: "noreply@intra-ai.de" } } };
    runtime.createMailer = () => ({ send: async () => ({ messageId: "<m@test>", responseCode: 250 }), close: () => undefined });
    runtime.every = (ms, run) => {
      steps.push(`every ${ms}`);
      task = run;
      return { stop: () => undefined };
    };

    await runWeb(runtime);
    expect(steps).toContain("every 60000");
    await task?.();

    // The fake pool reaches no database, so the scan fails, and the next minute tries again.
    expect(testLog.events("security_watch_failed")).toEqual([{ event: "security_watch_failed", err_name: "Error" }]);
  });

  it("on SIGTERM stops the watch, closes the server, waits for background work, closes the mailer, ends the pool, flushes the log and exits 0", async () => {
    const { runtime, steps, pool } = fakeRuntime();
    const handlers = new Map<string, () => void>();
    runtime.env = { ...ENV, loginSmtp: { host: "smtp.test", port: 587, user: "noreply@intra-ai.de", password: "p", from: { name: "", address: "noreply@intra-ai.de" } } };
    runtime.createMailer = () => ({ send: async () => ({ messageId: "<m@test>", responseCode: 250 }), close: () => void steps.push("mailer close") });
    runtime.onSignal = (signal, handler) => void handlers.set(signal, handler);

    await runWeb(runtime);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    steps.length = 0;
    handlers.get("SIGTERM")?.();

    await vi.waitFor(() => expect(steps.at(-1)).toBe("exit 0"));
    expect(steps).toEqual(["timer stop", "server close", "mailer close", "flush", "exit 0"]);
    expect(pool()?.ended).toBe(true);
  });

  it("on a failed role check logs the failing step, opens no pool, never listens and exits 1", async () => {
    const { runtime, steps, testLog } = fakeRuntime();
    runtime.checkRole = async () => {
      throw new RoleCheckError("web role check failed at statement_timeout: 0");
    };

    await runWeb(runtime);

    expect(steps).toEqual(["flush", "exit 1"]);
    expect(testLog.events("web_start_failed")).toEqual([{ event: "web_start_failed", reason: "web role check failed at statement_timeout: 0" }]);
  });

  it("ignores a second signal while it shuts down, so the pool is ended once", async () => {
    const { runtime, steps } = fakeRuntime();
    const handlers = new Map<string, () => void>();
    runtime.onSignal = (signal, handler) => void handlers.set(signal, handler);

    await runWeb(runtime);
    handlers.get("SIGTERM")?.();
    handlers.get("SIGINT")?.();

    await vi.waitFor(() => expect(steps.at(-1)).toBe("exit 0"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(steps.filter((step) => step === "server close" || step.startsWith("exit"))).toEqual(["server close", "exit 0"]);
  });
});

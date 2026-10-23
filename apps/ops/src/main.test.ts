import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate-command.js", () => ({ runMigrateCommand: vi.fn(async () => 3) }));
vi.mock("./products-command.js", () => ({ runProductsCommand: vi.fn(async () => 1) }));
vi.mock("./settings-command.js", () => ({ runSettingsCommand: vi.fn(async () => 0) }));
vi.mock("./searches-command.js", () => ({ runSearchesCommand: vi.fn(async () => 0), runPlanCommand: vi.fn(async () => 1) }));
vi.mock("./auth-command.js", () => ({ runAuthCommand: vi.fn(async () => 2) }));

const USAGE =
  "usage: node dist/main.js migrate | products list|show|set|pause|resume|archive|pause-all|import-legacy ... | searches list | plan | settings list|set ... | auth users|user|sessions|unlock|code ...\n";

async function runMain(argv: string[]): Promise<void> {
  vi.resetModules();
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "main.js", ...argv]);
  await import("./main.js");
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("main", () => {
  it("prints the usage and exits 2 for an unknown command", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runMain(["drop-everything"]);

    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(USAGE);
  });

  it.each([["feeds", "pause", "gpu"], ["rules", "list"]])("no longer knows %s: v2 does not read app.feed or app.segment_rule", async (...argv) => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await runMain(argv);

    expect(process.exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(USAGE);
  });

  it("runs the migrate command with the real env loader and exits with its code", async () => {
    await runMain(["migrate"]);

    const { runMigrateCommand } = await import("./migrate-command.js");
    const { loadEnv } = await import("./env.js");
    expect(process.exitCode).toBe(3);
    expect(runMigrateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ loadEnv, runMigrations: expect.any(Function), log: expect.any(Object) }),
    );
  });

  it("hands the migrate command the web role check and the bootstrap of the first admins", async () => {
    await runMain(["migrate"]);

    const { runMigrateCommand } = await import("./migrate-command.js");
    const { bootstrapAdmins, checkWebRole } = await import("@ebay-sniper/db/queue");
    expect(runMigrateCommand).toHaveBeenCalledWith(expect.objectContaining({ bootstrapAdmins, checkWebRole }));
  });

  it("passes the migrate, role and pg-boss functions of the db package to the migrate command", async () => {
    await runMain(["migrate"]);

    const { runMigrateCommand } = await import("./migrate-command.js");
    const db = await import("@ebay-sniper/db");
    const queue = await import("@ebay-sniper/db/queue");
    expect(runMigrateCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        runMigrations: db.runMigrations,
        setRolePassword: queue.setRolePassword,
        migrateQueue: queue.migrateQueue,
        checkAppRole: db.checkAppRole,
        checkWorkerRole: queue.checkWorkerRole,
        checkDashboardRole: queue.checkDashboardRole,
      }),
    );
  });

  it("runs settings with its arguments and the settings ceilings and screening evals", async () => {
    await runMain(["settings", "set", "alerts.per_hour", "5"]);

    const { runSettingsCommand } = await import("./settings-command.js");
    const env = await import("./env.js");
    expect(process.exitCode).toBe(0);
    expect(runSettingsCommand).toHaveBeenCalledWith(
      ["set", "alerts.per_hour", "5"],
      expect.objectContaining({ loadSettingsEnv: env.loadSettingsEnv, screeningEvals: expect.any(Array) }),
    );
  });

  it("runs searches list and plan with their arguments", async () => {
    // runMain loads the modules afresh, so each call is checked before the next one.
    await runMain(["searches", "list"]);
    expect(process.exitCode).toBe(0);
    expect((await import("./searches-command.js")).runSearchesCommand).toHaveBeenCalledWith(
      ["list"],
      expect.objectContaining({ loadSettingsEnv: (await import("./env.js")).loadSettingsEnv }),
    );

    await runMain(["plan"]);
    expect(process.exitCode).toBe(1);
    expect((await import("./searches-command.js")).runPlanCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ loadSettingsEnv: (await import("./env.js")).loadSettingsEnv }),
    );
  });

  it("runs auth with its arguments, the AUTH_KEY loader and the terminal question", async () => {
    await runMain(["auth", "code", "info@intra-ai.de", "--ref", "K7QF"]);

    const { runAuthCommand } = await import("./auth-command.js");
    const env = await import("./env.js");
    expect(process.exitCode).toBe(2);
    expect(runAuthCommand).toHaveBeenCalledWith(
      ["code", "info@intra-ai.de", "--ref", "K7QF"],
      expect.objectContaining({ loadAuthKey: env.loadAuthKey, ask: expect.any(Function) }),
    );
  });

  it("runs products with its arguments, the real env loaders, the db pool, the system clock and the passed screening evals", async () => {
    await runMain(["products", "list"]);

    const { runProductsCommand } = await import("./products-command.js");
    const env = await import("./env.js");
    const { systemClock } = await import("./clock.js");
    const db = await import("@ebay-sniper/db");
    const llm = await import("@ebay-sniper/llm/catalog");
    expect(process.exitCode).toBe(1);
    expect(runProductsCommand).toHaveBeenCalledWith(
      ["list"],
      expect.objectContaining({
        loadEnv: env.loadDatabaseEnv,
        loadSettingsEnv: env.loadSettingsEnv,
        loadAuthKey: env.loadAuthKey,
        screeningEvals: llm.passedChoices(llm.PROMPT_VERSION),
        createPool: db.createPool,
        clock: systemClock,
        ask: expect.any(Function),
      }),
    );
  });
});

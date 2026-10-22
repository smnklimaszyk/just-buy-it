import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./migrate-command.js", () => ({ runMigrateCommand: vi.fn(async () => 3) }));
vi.mock("./feeds-command.js", () => ({ runFeedsCommand: vi.fn(async () => 1) }));
vi.mock("./rules-command.js", () => ({ runRulesCommand: vi.fn(async () => 0) }));

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
    expect(stderr).toHaveBeenCalledWith(
      "usage: node dist/main.js migrate | feeds pause|resume <feed> | feeds set <feed> <field> <value> | rules list | rules set <segment> <field> <value>\n",
    );
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

  it.each([
    ["feeds", ["pause", "gpu"], 1],
    ["rules", ["list"], 0],
  ] as const)("runs %s with its arguments, the database env, the db pool and the system clock", async (command, args, code) => {
    await runMain([command, ...args]);

    const { runFeedsCommand } = await import("./feeds-command.js");
    const { runRulesCommand } = await import("./rules-command.js");
    const run = command === "feeds" ? runFeedsCommand : runRulesCommand;
    const { loadDatabaseEnv } = await import("./env.js");
    const { systemClock } = await import("./clock.js");
    const db = await import("@ebay-sniper/db");
    expect(process.exitCode).toBe(code);
    expect(run).toHaveBeenCalledWith(
      args,
      expect.objectContaining({ loadEnv: loadDatabaseEnv, createPool: db.createPool, clock: systemClock }),
    );
  });
});

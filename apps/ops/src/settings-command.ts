import { loadSettings, saveSettings, type DbPool } from "@ebay-sniper/db";
import { configContext, failed, refused, UsageError, withPool, type OpsDeps } from "./change.js";

const USAGE = "usage: settings list | set <key> <json>";

// The settings in force (each .env ceiling applied), warnings about stored values, and the rows.
async function list(pool: DbPool, deps: OpsDeps): Promise<number> {
  const { settings, warnings } = await loadSettings(pool, deps.loadSettingsEnv());
  const stored = await pool.query("SELECT key, value, version, updated_at AS \"updatedAt\" FROM app.setting ORDER BY key");
  deps.out(JSON.stringify({ settings, warnings, stored: stored.rows }));
  return 0;
}

function jsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new UsageError('the value must be JSON, for example 5 or "2.00"');
  }
}

// Through the same checks as the Settings page: the bounds of each key, the .env ceiling and the
// daily call plan.
async function set(pool: DbPool, deps: OpsDeps, key: string, value: unknown): Promise<number> {
  const result = await saveSettings(pool, [{ key, value }], configContext(deps), deps.screeningEvals);
  if (!result.ok) return refused(deps, result);
  deps.out(JSON.stringify({ ...result.settings, plan: result.plan }));
  return 0;
}

export async function runSettingsCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    const [action, key, value] = args;
    if (action === "list" && args.length === 1) return await withPool(deps, (pool) => list(pool, deps));
    if (action === "set" && key !== undefined && value !== undefined && args.length === 3) {
      const parsed = jsonValue(value);
      return await withPool(deps, (pool) => set(pool, deps, key, parsed));
    }
    throw new UsageError(USAGE);
  } catch (error) {
    return failed(deps, error);
  }
}

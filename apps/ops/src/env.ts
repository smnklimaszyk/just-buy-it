import type { SettingsEnv } from "@ebay-sniper/domain";
import { z } from "zod";

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const rolePassword = z.string().regex(/^[0-9a-f]{64}$/);

// Spec 7.2: trimmed, lower case, NFC, at most 254 characters and exactly one @.
const email = z.string().max(254).regex(/^[^@\s]+@[^@\s]+$/);
const adminList = z
  .string()
  .transform((value) => [...new Set(value.split(",").map((part) => part.trim().toLowerCase().normalize("NFC")))])
  .pipe(z.array(email).min(1));

const databaseSchema = z.object({ DATABASE_URL: databaseUrl });

const migrateSchema = databaseSchema.extend({
  POSTGRES_APP_PASSWORD: rolePassword,
  POSTGRES_WORKER_PASSWORD: rolePassword,
  POSTGRES_DASHBOARD_PASSWORD: rolePassword,
  POSTGRES_WEB_PASSWORD: rolePassword,
  AUTH_BOOTSTRAP_ADMINS: adminList,
});

// `ops migrate`: the owner URL, the passwords of the four service roles, and the addresses that
// become admin while no active admin exists (spec 7.8).
export type Env = {
  databaseUrl: string;
  appRolePassword: string;
  workerRolePassword: string;
  dashboardRolePassword: string;
  webRolePassword: string;
  bootstrapAdmins: string[];
};

// Every command but `ops migrate`: the owner URL only.
export type DatabaseEnv = { databaseUrl: string };

export class EnvError extends Error {}

// The message names the failing variables only: DATABASE_URL and the passwords are secrets.
function parsed<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    // The variable alone: an issue inside a list (AUTH_BOOTSTRAP_ADMINS) has the entry's index too.
    const names = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  return result.data;
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const env = parsed(migrateSchema, source);
  return {
    databaseUrl: env.DATABASE_URL,
    appRolePassword: env.POSTGRES_APP_PASSWORD,
    workerRolePassword: env.POSTGRES_WORKER_PASSWORD,
    dashboardRolePassword: env.POSTGRES_DASHBOARD_PASSWORD,
    webRolePassword: env.POSTGRES_WEB_PASSWORD,
    bootstrapAdmins: env.AUTH_BOOTSTRAP_ADMINS,
  };
}

export function parseDatabaseEnv(source: Record<string, string | undefined>): DatabaseEnv {
  return { databaseUrl: parsed(databaseSchema, source).DATABASE_URL };
}

// The .env ceilings of the Claude settings and the default buyer profile, as the worker reads
// them (spec 2.5). Compose passes "" for an unset ${VAR:-}, so an empty value counts as unset.
const settingsSchema = z.object({
  CLAUDE_DAILY_CALL_LIMIT: z.coerce.number().int().nonnegative().optional(),
  CLAUDE_DAILY_SPEND_LIMIT_USD: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  BUYER_PROFILE: z.enum(["company", "private"]).optional(),
});

function usdToMicrousd(usd: string): number {
  const [whole = "0", fraction = ""] = usd.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(2, "0")) * 10_000;
}

export function parseSettingsEnv(source: Record<string, string | undefined>): SettingsEnv {
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const env = parsed(settingsSchema, set);
  return {
    claudeDailyCallLimit: env.CLAUDE_DAILY_CALL_LIMIT ?? 40,
    claudeDailySpendLimitMicrousd: usdToMicrousd(env.CLAUDE_DAILY_SPEND_LIMIT_USD ?? "2"),
    buyerProfile: env.BUYER_PROFILE ?? null,
  };
}

// AUTH_KEY (spec 7.3): 32 random bytes in base64. `ops auth code` and `ops auth unlock` derive
// the same subkeys from it as web.
const authKeySchema = z.object({
  AUTH_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .transform((value) => Buffer.from(value, "base64")),
});

export function parseAuthKey(source: Record<string, string | undefined>): Buffer {
  return parsed(authKeySchema, source).AUTH_KEY;
}

// The only process.env reads in this app (ADR 0006).
export function loadEnv(): Env {
  return parseEnv(process.env);
}

export function loadDatabaseEnv(): DatabaseEnv {
  return parseDatabaseEnv(process.env);
}

export function loadSettingsEnv(): SettingsEnv {
  return parseSettingsEnv(process.env);
}

export function loadAuthKey(): Buffer {
  return parseAuthKey(process.env);
}

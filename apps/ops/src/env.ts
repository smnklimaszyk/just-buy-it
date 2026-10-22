import { z } from "zod";

const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const rolePassword = z.string().regex(/^[0-9a-f]{64}$/);

const databaseSchema = z.object({ DATABASE_URL: databaseUrl });

const migrateSchema = databaseSchema.extend({
  POSTGRES_APP_PASSWORD: rolePassword,
  POSTGRES_WORKER_PASSWORD: rolePassword,
  POSTGRES_DASHBOARD_PASSWORD: rolePassword,
});

// `ops migrate`: the owner URL and the passwords of the three service roles.
export type Env = {
  databaseUrl: string;
  appRolePassword: string;
  workerRolePassword: string;
  dashboardRolePassword: string;
};

// `ops feeds` and `ops rules`: the owner URL only.
export type DatabaseEnv = { databaseUrl: string };

export class EnvError extends Error {}

// The message names the failing variables only: DATABASE_URL and the passwords are secrets.
function parsed<T extends z.ZodType>(schema: T, source: Record<string, string | undefined>): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
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
  };
}

export function parseDatabaseEnv(source: Record<string, string | undefined>): DatabaseEnv {
  return { databaseUrl: parsed(databaseSchema, source).DATABASE_URL };
}

// The only process.env reads in this app (ADR 0006).
export function loadEnv(): Env {
  return parseEnv(process.env);
}

export function loadDatabaseEnv(): DatabaseEnv {
  return parseDatabaseEnv(process.env);
}

import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  POSTGRES_APP_PASSWORD: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Env = { databaseUrl: string; appRolePassword: string };

export class EnvError extends Error {}

// The message names the failing variables only: DATABASE_URL and POSTGRES_APP_PASSWORD hold passwords.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL, appRolePassword: parsed.data.POSTGRES_APP_PASSWORD };
}

// The only process.env read in this app (ADR 0006).
export function loadEnv(): Env {
  return parseEnv(process.env);
}

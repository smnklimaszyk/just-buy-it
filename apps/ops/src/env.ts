import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

export type Env = { databaseUrl: string };

export class EnvError extends Error {}

// The message names the failing variables only: a value such as DATABASE_URL holds a password.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  return { databaseUrl: parsed.data.DATABASE_URL };
}

// The only process.env read in this app (ADR 0006).
export function loadEnv(): Env {
  return parseEnv(process.env);
}

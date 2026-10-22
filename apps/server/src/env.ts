import { z } from "zod";

const API_BASE = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" } as const;

// Compose passes "" for an unset ${VAR:-}; the eBay credentials may be absent before they exist.
const optionalValue = z.preprocess((value) => (value === "" ? undefined : value), z.string().min(1).optional());

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  EBAY_ENVIRONMENT: z.enum(["production", "sandbox"]),
  EBAY_DELETION_ENDPOINT_URL: z.url({ protocol: /^https$/ }),
  EBAY_DELETION_VERIFICATION_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{32,80}$/),
  EBAY_CLIENT_ID: optionalValue,
  EBAY_CLIENT_SECRET: optionalValue,
  GIT_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DELETION_PROBE_CODE: z.string().regex(/^[A-Za-z0-9_-]{40}$/),
  // The internal dashboard's own listener and its read-only database role (section 8.1).
  DASHBOARD_PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65_535).default(3001),
  ),
  DASHBOARD_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
}).refine((env) => env.DASHBOARD_PORT !== env.PORT, {
  path: ["DASHBOARD_PORT"],
  message: "the dashboard needs its own port",
});

export type Env = {
  port: number;
  ebayApiBase: string;
  deletionEndpointUrl: string;
  deletionVerificationToken: string;
  ebayClientId: string | undefined;
  ebayClientSecret: string | undefined;
  gitSha: string;
  databaseUrl: string;
  deletionProbeCode: string;
  dashboardPort: number;
  dashboardDatabaseUrl: string;
};

export class EnvError extends Error {}

// The message names the failing variables only: a ZodError message can quote a value, and
// DATABASE_URL, DASHBOARD_DATABASE_URL and the deletion token are secrets.
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  const env = parsed.data;
  return {
    port: env.PORT,
    ebayApiBase: API_BASE[env.EBAY_ENVIRONMENT],
    deletionEndpointUrl: env.EBAY_DELETION_ENDPOINT_URL,
    deletionVerificationToken: env.EBAY_DELETION_VERIFICATION_TOKEN,
    ebayClientId: env.EBAY_CLIENT_ID,
    ebayClientSecret: env.EBAY_CLIENT_SECRET,
    gitSha: env.GIT_SHA,
    databaseUrl: env.DATABASE_URL,
    deletionProbeCode: env.DELETION_PROBE_CODE,
    dashboardPort: env.DASHBOARD_PORT,
    dashboardDatabaseUrl: env.DASHBOARD_DATABASE_URL,
  };
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}

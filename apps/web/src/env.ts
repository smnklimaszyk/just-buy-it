import type { SettingsEnv } from "@ebay-sniper/domain";
import { parseSender, SenderError, type Sender, type SmtpConfig } from "@ebay-sniper/notify";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535),
  // As role web (spec 2.10).
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  GIT_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  // Spec 7.3: 32 random bytes in base64, for web and ops only.
  AUTH_KEY: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .transform((value) => Buffer.from(value, "base64")),
  // The address people type, as an origin: the CSRF check compares Origin with it (spec 7.6).
  PUBLIC_ORIGIN: z.url({ protocol: /^https$/ }).refine((value) => new URL(value).origin === value),
  // Always among a product's alert recipients (spec 8.4); the product form shows it.
  ALERT_TO: z.email(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  // The .env ceilings of the settings (spec 2.5), as the worker reads them.
  CLAUDE_DAILY_CALL_LIMIT: z.coerce.number().int().nonnegative().optional(),
  CLAUDE_DAILY_SPEND_LIMIT_USD: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  BUYER_PROFILE: z.enum(["company", "private"]).optional(),
  // The noreply@intra-ai.de mailbox, never the alert mailbox (owner decision 2, ADR 0038).
  LOGIN_SMTP_HOST: z.string().optional(),
  LOGIN_SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  LOGIN_SMTP_USER: z.string().optional(),
  LOGIN_SMTP_PASSWORD: z.string().optional(),
  LOGIN_FROM: z.string().optional(),
});

type ParsedEnv = z.infer<typeof envSchema>;

const LOGIN_SMTP_NAMES = ["LOGIN_SMTP_HOST", "LOGIN_SMTP_PORT", "LOGIN_SMTP_USER", "LOGIN_SMTP_PASSWORD", "LOGIN_FROM"] as const;

// All five or none, like the worker's SMTP_* (ADR 0035).
function loginSmtp(env: ParsedEnv): SmtpConfig | null {
  const { LOGIN_SMTP_HOST, LOGIN_SMTP_PORT, LOGIN_SMTP_USER, LOGIN_SMTP_PASSWORD, LOGIN_FROM } = env;
  if (
    LOGIN_SMTP_HOST === undefined ||
    LOGIN_SMTP_PORT === undefined ||
    LOGIN_SMTP_USER === undefined ||
    LOGIN_SMTP_PASSWORD === undefined ||
    LOGIN_FROM === undefined
  ) {
    const missing = LOGIN_SMTP_NAMES.filter((name) => env[name] === undefined);
    if (missing.length === LOGIN_SMTP_NAMES.length) return null;
    throw new EnvError(`invalid environment: LOGIN_SMTP is set partially, missing ${missing.join(", ")}`);
  }
  return { host: LOGIN_SMTP_HOST, port: LOGIN_SMTP_PORT, user: LOGIN_SMTP_USER, password: LOGIN_SMTP_PASSWORD, from: sender(LOGIN_FROM) };
}

// parseSender names ALERT_FROM in its message, never the value.
function sender(value: string): Sender {
  try {
    return parseSender(value);
  } catch (error) {
    if (error instanceof SenderError) throw new EnvError(`invalid environment: ${error.message.replace("ALERT_FROM", "LOGIN_FROM")}`);
    throw error;
  }
}

export type WebEnv = {
  port: number;
  databaseUrl: string;
  gitSha: string;
  authKey: Buffer;
  publicOrigin: string;
  // null: no sign-in mail; only `ops auth code` signs people in (ADR 0038).
  loginSmtp: SmtpConfig | null;
  settingsEnv: SettingsEnv;
  alertTo: string;
  logLevel: string;
};

// "2.50" as 2,500,000 micro-USD, without a float.
function usdToMicrousd(usd: string): number {
  const [whole = "0", fraction = ""] = usd.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(2, "0")) * 10_000;
}

export class EnvError extends Error {}

export function parseEnv(source: Record<string, string | undefined>): WebEnv {
  // Compose passes "" for an unset ${VAR:-}, so an empty value counts as unset.
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse(set);
  // The message names the failing variables only: DATABASE_URL, AUTH_KEY and the mailbox
  // password are secrets, and a ZodError message can quote a value.
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  const env = parsed.data;
  return {
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    gitSha: env.GIT_SHA,
    authKey: env.AUTH_KEY,
    publicOrigin: env.PUBLIC_ORIGIN,
    loginSmtp: loginSmtp(env),
    settingsEnv: {
      claudeDailyCallLimit: env.CLAUDE_DAILY_CALL_LIMIT ?? 40,
      claudeDailySpendLimitMicrousd: usdToMicrousd(env.CLAUDE_DAILY_SPEND_LIMIT_USD ?? "2"),
      buyerProfile: env.BUYER_PROFILE ?? null,
    },
    alertTo: env.ALERT_TO,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

// The only process.env read in this app (ADR 0006).
export function loadEnv(): WebEnv {
  return parseEnv(process.env);
}

import type { BuyerProfile } from "@ebay-sniper/domain";
import { MODEL } from "@ebay-sniper/llm";
import { parseSender, SenderError, type Sender, type SmtpConfig } from "@ebay-sniper/notify";
import { z } from "zod";

const API_BASE = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" } as const;

const ITEM_KEY_BYTES = 32;

// Exactly 32 bytes in canonical base64 (`openssl rand -base64 32`).
const itemKey = z
  .string()
  .refine((value) => {
    const bytes = Buffer.from(value, "base64");
    return bytes.length === ITEM_KEY_BYTES && bytes.toString("base64") === value;
  });

const envSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  GIT_SHA: z.string().regex(/^[0-9a-f]{40}$/),
  EBAY_ENVIRONMENT: z.enum(["production", "sandbox"]),
  EBAY_CLIENT_ID: z.string().min(1),
  EBAY_CLIENT_SECRET: z.string().min(1),
  EBAY_ENDUSERCTX_POSTAL_CODE: z.string().regex(/^\d{5}$/).optional(),
  ITEM_KEY_V1: itemKey,
  BUYER_PROFILE: z.enum(["company", "private"]).optional(),
  ALERT_TO: z.email(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CLAUDE_MODEL: z.literal(MODEL).optional(),
  CLAUDE_DAILY_CALL_LIMIT: z.coerce.number().int().nonnegative().optional(),
  CLAUDE_DAILY_SPEND_LIMIT_USD: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  ALERT_FROM: z.string().optional(),
});

type ParsedEnv = z.infer<typeof envSchema>;

const SMTP_NAMES = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "ALERT_FROM"] as const;

// All five SMTP variables or none (section 9.1).
function smtpConfig(env: ParsedEnv): SmtpConfig | null {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, ALERT_FROM } = env;
  if (SMTP_HOST === undefined || SMTP_PORT === undefined || SMTP_USER === undefined || SMTP_PASSWORD === undefined || ALERT_FROM === undefined) {
    const missing = SMTP_NAMES.filter((name) => env[name] === undefined);
    if (missing.length === SMTP_NAMES.length) return null;
    throw new EnvError(`invalid environment: SMTP is set partially, missing ${missing.join(", ")}`);
  }
  return { host: SMTP_HOST, port: SMTP_PORT, user: SMTP_USER, password: SMTP_PASSWORD, from: sender(ALERT_FROM) };
}

// The SenderError message names ALERT_FROM and the problem, never the value.
function sender(value: string): Sender {
  try {
    return parseSender(value);
  } catch (error) {
    if (error instanceof SenderError) throw new EnvError(`invalid environment: ${error.message}`);
    throw error;
  }
}

// "2.50" as 2,500,000 micro-USD, without a float.
function usdToMicrousd(usd: string): number {
  const [whole = "0", fraction = ""] = usd.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(2, "0")) * 10_000;
}

export type ClaudeEnv = {
  // null: screening is skipped and alerts say "Not screened by Claude: not_configured".
  apiKey: string | null;
  // Per Berlin day; 0 switches screening off.
  callLimit: number;
  spendLimitMicrousd: number;
};

export type WorkerEnv = {
  databaseUrl: string;
  statementTimeoutMs: number;
  gitSha: string;
  ebayApiBase: string;
  ebayClientId: string;
  ebayClientSecret: string;
  postalCode: string;
  itemKeySecret: string;
  buyerProfile: BuyerProfile;
  claude: ClaudeEnv;
  // null: alerts stay pending with hold_reason smtp_not_configured.
  smtp: SmtpConfig | null;
  alertTo: string;
  logLevel: string;
};

export class EnvError extends Error {}

// The message names the failing variables only, never a value: DATABASE_URL, the eBay secret, the
// Claude key and the SMTP password are secrets.
export function parseEnv(source: Record<string, string | undefined>): WorkerEnv {
  // Compose passes "" for an unset ${VAR:-}, so an empty value counts as unset.
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const parsed = envSchema.safeParse(set);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new EnvError(`invalid environment: ${names.join(", ")}`);
  }
  const env = parsed.data;
  return {
    databaseUrl: env.DATABASE_URL,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? 10_000,
    gitSha: env.GIT_SHA,
    ebayApiBase: API_BASE[env.EBAY_ENVIRONMENT],
    ebayClientId: env.EBAY_CLIENT_ID,
    ebayClientSecret: env.EBAY_CLIENT_SECRET,
    postalCode: env.EBAY_ENDUSERCTX_POSTAL_CODE ?? "80331",
    itemKeySecret: env.ITEM_KEY_V1,
    buyerProfile: env.BUYER_PROFILE ?? "company",
    claude: {
      apiKey: env.ANTHROPIC_API_KEY ?? null,
      callLimit: env.CLAUDE_DAILY_CALL_LIMIT ?? 40,
      spendLimitMicrousd: usdToMicrousd(env.CLAUDE_DAILY_SPEND_LIMIT_USD ?? "2"),
    },
    smtp: smtpConfig(env),
    alertTo: env.ALERT_TO,
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

// The only process.env read in this app (ADR 0006).
export function loadEnv(): WorkerEnv {
  return parseEnv(process.env);
}

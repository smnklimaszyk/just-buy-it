import { z } from "zod";

const API_BASE = { production: "https://api.ebay.com", sandbox: "https://api.sandbox.ebay.com" } as const;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  EBAY_ENVIRONMENT: z.enum(["production", "sandbox"]),
  EBAY_DELETION_ENDPOINT_URL: z.url({ protocol: /^https$/ }),
  EBAY_DELETION_VERIFICATION_TOKEN: z.string().regex(/^[A-Za-z0-9_-]{32,80}$/),
  EBAY_CLIENT_ID: z.string().min(1).optional(),
  EBAY_CLIENT_SECRET: z.string().min(1).optional(),
  GIT_SHA: z.string().regex(/^[0-9a-f]{40}$/),
});

export type Env = {
  port: number;
  ebayApiBase: string;
  deletionEndpointUrl: string;
  deletionVerificationToken: string;
  ebayClientId: string | undefined;
  ebayClientSecret: string | undefined;
  gitSha: string;
};

export function parseEnv(source: Record<string, string | undefined>): Env {
  const env = envSchema.parse(source);
  return {
    port: env.PORT,
    ebayApiBase: API_BASE[env.EBAY_ENVIRONMENT],
    deletionEndpointUrl: env.EBAY_DELETION_ENDPOINT_URL,
    deletionVerificationToken: env.EBAY_DELETION_VERIFICATION_TOKEN,
    ebayClientId: env.EBAY_CLIENT_ID,
    ebayClientSecret: env.EBAY_CLIENT_SECRET,
    gitSha: env.GIT_SHA,
  };
}

export function loadEnv(): Env {
  return parseEnv(process.env);
}

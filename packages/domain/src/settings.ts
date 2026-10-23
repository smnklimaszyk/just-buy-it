import type { BuyerProfile } from "./vat.js";

// Spec 2.5. Platform settings live in app.setting; a missing row is the code default. Secrets
// and the two Claude ceilings stay in .env.
export const CLAUDE_EFFORTS = ["low", "medium", "high"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

// The .env values a setting is bounded by or defaults to. Spend in micro-USD, as the worker's
// ClaudeEnv holds it.
export type SettingsEnv = {
  claudeDailyCallLimit: number;
  claudeDailySpendLimitMicrousd: number;
  buyerProfile: BuyerProfile | null;
};

export type Settings = {
  claudeModel: string;
  claudeEffort: ClaudeEffort;
  claudeDailyCallLimit: number;
  claudeDailySpendLimitMicrousd: number;
  alertsPerHour: number;
  alertsPerDay: number;
  defaultBuyerProfile: BuyerProfile;
  lowFeedbackBelow: number;
};

// An app.setting row as the store reads it.
export type SettingRow = { key: string; value: unknown };

export type ResolvedSettings = { settings: Settings; warnings: string[] };

type Parsed = { ok: true; patch: Partial<Settings> } | { ok: false; error: string };

const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const USD = /^(\d{1,6})(?:\.(\d{1,2}))?$/;

// "2.50" as 2,500,000 micro-USD, without a float.
function usdToMicrousd(usd: string): number | null {
  const match = USD.exec(usd);
  if (match === null) return null;
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(2, "0")) * 10_000;
}

const MODEL_ID = /^claude-[a-z0-9-]{1,60}$/;

// One parser per key: the stored JSON value to the field it sets, with the bounds of spec 2.5.
// The .env ceilings come on top, on save and on every read.
const PARSERS: Record<string, (value: unknown) => Parsed> = {
  "claude.model": (value) =>
    typeof value === "string" && MODEL_ID.test(value)
      ? { ok: true, patch: { claudeModel: value } }
      : { ok: false, error: "Choose a Claude model." },
  "claude.effort": (value) => {
    const effort = CLAUDE_EFFORTS.find((option) => option === value);
    return effort ? { ok: true, patch: { claudeEffort: effort } } : { ok: false, error: "Choose low, medium or high." };
  },
  "claude.daily_call_limit": (value) =>
    wholeIn(value, 0, Number.MAX_SAFE_INTEGER)
      ? { ok: true, patch: { claudeDailyCallLimit: value } }
      : { ok: false, error: "Enter a whole number of calls, 0 or more." },
  "claude.daily_spend_limit_usd": (value) => {
    const microusd = typeof value === "string" ? usdToMicrousd(value) : null;
    return microusd === null
      ? { ok: false, error: 'Enter US dollars with up to two decimals, for example "2.00".' }
      : { ok: true, patch: { claudeDailySpendLimitMicrousd: microusd } };
  },
  "alerts.per_hour": (value) =>
    wholeIn(value, 1, 20) ? { ok: true, patch: { alertsPerHour: value } } : { ok: false, error: "Enter 1 to 20." },
  "alerts.per_day": (value) =>
    wholeIn(value, 1, 100) ? { ok: true, patch: { alertsPerDay: value } } : { ok: false, error: "Enter 1 to 100." },
  "alerts.default_buyer_profile": (value) =>
    value === "company" || value === "private"
      ? { ok: true, patch: { defaultBuyerProfile: value } }
      : { ok: false, error: "Choose company or private." },
  "matcher.low_feedback_below": (value) =>
    wholeIn(value, 0, 1000) ? { ok: true, patch: { lowFeedbackBelow: value } } : { ok: false, error: "Enter 0 to 1000." },
};

// undefined for an unknown key. Own keys only, so "constructor" or "__proto__" are unknown too.
const parse = (key: string, value: unknown): Parsed | undefined =>
  Object.hasOwn(PARSERS, key) ? PARSERS[key]?.(value) : undefined;

// The code defaults in their stored form, so a default passes the same parser as a row.
const storedDefaults = (env: SettingsEnv): Record<string, unknown> => ({
  "claude.model": "claude-sonnet-5-5",
  "claude.effort": "medium",
  "claude.daily_call_limit": 40,
  "claude.daily_spend_limit_usd": "2.00",
  "alerts.per_hour": 10,
  "alerts.per_day": 60,
  "alerts.default_buyer_profile": env.buyerProfile ?? "company",
  "matcher.low_feedback_below": 10,
});

function defaults(env: SettingsEnv): Settings {
  return {
    claudeModel: "claude-sonnet-5-5",
    claudeEffort: "medium",
    claudeDailyCallLimit: 40,
    claudeDailySpendLimitMicrousd: 2_000_000,
    alertsPerHour: 10,
    alertsPerDay: 60,
    defaultBuyerProfile: env.buyerProfile ?? "company",
    lowFeedbackBelow: 10,
  };
}

// The .env ceiling bounds the setting on every read (spec 2.5), so `ops settings set`, SQL or a
// lowered .env never let a stored value through.
export function effectiveLimit(setting: number, ceiling: number): number {
  return Math.min(setting, ceiling);
}

// "$2.00".
export function formatUsd(microusd: number): string {
  return `$${(microusd / 1_000_000).toFixed(2)}`;
}

export function resolveSettings(rows: readonly SettingRow[], env: SettingsEnv): ResolvedSettings {
  let stored = defaults(env);
  const warnings: string[] = [];
  for (const row of rows) {
    const parsed = parse(row.key, row.value);
    if (parsed === undefined) continue;
    if (parsed.ok) stored = { ...stored, ...parsed.patch };
    else {
      const fallback = JSON.stringify(storedDefaults(env)[row.key]);
      warnings.push(`Stored setting ${row.key} is not valid (${parsed.error}); the default ${fallback} applies.`);
    }
  }
  const settings = { ...stored };
  for (const cap of ceilings(env)) {
    const value = stored[cap.field];
    // A code default above a lowered .env is not stored, so it needs no warning.
    if (value > cap.ceiling && rows.some((row) => row.key === cap.key)) {
      const ceiling = cap.show(cap.ceiling);
      warnings.push(`Stored Claude ${cap.name} cap ${cap.show(value)} is above the server ceiling ${ceiling}; ${ceiling} applies.`);
    }
    settings[cap.field] = effectiveLimit(value, cap.ceiling);
  }
  return { settings, warnings };
}

type Ceiling = {
  key: string;
  name: string;
  field: "claudeDailyCallLimit" | "claudeDailySpendLimitMicrousd";
  ceiling: number;
  show: (value: number) => string;
  refusal: string;
};

const ceilings = (env: SettingsEnv): Ceiling[] => [
  {
    key: "claude.daily_call_limit",
    name: "call",
    field: "claudeDailyCallLimit",
    ceiling: env.claudeDailyCallLimit,
    show: String,
    refusal: `The server ceiling is ${env.claudeDailyCallLimit} calls a day (CLAUDE_DAILY_CALL_LIMIT).`,
  },
  {
    key: "claude.daily_spend_limit_usd",
    name: "spend",
    field: "claudeDailySpendLimitMicrousd",
    ceiling: env.claudeDailySpendLimitMicrousd,
    show: formatUsd,
    refusal: `The server ceiling is ${formatUsd(env.claudeDailySpendLimitMicrousd)} a day (CLAUDE_DAILY_SPEND_LIMIT_USD).`,
  },
];

export type ModelChoice = { model: string; effort: string };

// Spec 4.6: claude.model and claude.effort together must be one entry of SCREENING_EVALS for the
// current prompt version. packages/llm owns that list; the caller passes its entries.
export function checkModelChoice(
  choice: ModelChoice,
  passed: readonly ModelChoice[],
): { ok: true } | { ok: false; error: string } {
  if (passed.some((entry) => entry.model === choice.model && entry.effort === choice.effort)) return { ok: true };
  return {
    ok: false,
    error: `${choice.model} at effort ${choice.effort} has not passed the screening eval for the current prompt.`,
  };
}

// The value to store, in its stored form ("1.5" is stored as "1.50").
export type SettingCheck = { ok: true; value: unknown } | { ok: false; error: string };

// Spec 2.5: a save is refused above the .env ceiling; the ceiling is applied again on read.
export function checkSetting(key: string, value: unknown, env: SettingsEnv): SettingCheck {
  const parsed = parse(key, value);
  if (parsed === undefined) return { ok: false, error: `Unknown setting ${key}.` };
  if (!parsed.ok) return parsed;
  const cap = ceilings(env).find((entry) => entry.key === key);
  const number = cap === undefined ? undefined : parsed.patch[cap.field];
  if (cap !== undefined && number !== undefined && number > cap.ceiling) return { ok: false, error: cap.refusal };
  const spend = parsed.patch.claudeDailySpendLimitMicrousd;
  return { ok: true, value: spend === undefined ? value : formatUsd(spend).slice(1) };
}

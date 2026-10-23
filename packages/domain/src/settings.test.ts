import { describe, expect, it } from "vitest";
import { checkModelChoice, checkSetting, resolveSettings, type SettingsEnv } from "./settings.js";

// The worker's .env defaults: 40 calls and USD 2.00 a Berlin day, no BUYER_PROFILE.
const env: SettingsEnv = { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000, buyerProfile: null };

describe("resolveSettings", () => {
  it("uses the code defaults of spec 2.5 when no row is stored", () => {
    expect(resolveSettings([], env)).toEqual({
      settings: {
        claudeModel: "claude-sonnet-5-5",
        claudeEffort: "medium",
        claudeDailyCallLimit: 40,
        claudeDailySpendLimitMicrousd: 2_000_000,
        alertsPerHour: 10,
        alertsPerDay: 60,
        defaultBuyerProfile: "company",
        lowFeedbackBelow: 10,
      },
      warnings: [],
    });
  });

  it("reads each stored row and takes the buyer profile default from BUYER_PROFILE", () => {
    const rows = [
      { key: "claude.model", value: "claude-haiku-5-5" },
      { key: "claude.effort", value: "low" },
      { key: "claude.daily_call_limit", value: 25 },
      { key: "claude.daily_spend_limit_usd", value: "1.50" },
      { key: "alerts.per_hour", value: 5 },
      { key: "alerts.per_day", value: 30 },
      { key: "matcher.low_feedback_below", value: 0 },
    ];
    expect(resolveSettings(rows, { ...env, buyerProfile: "private" })).toEqual({
      settings: {
        claudeModel: "claude-haiku-5-5",
        claudeEffort: "low",
        claudeDailyCallLimit: 25,
        claudeDailySpendLimitMicrousd: 1_500_000,
        alertsPerHour: 5,
        alertsPerDay: 30,
        defaultBuyerProfile: "private",
        lowFeedbackBelow: 0,
      },
      warnings: [],
    });
    const stored = resolveSettings([{ key: "alerts.default_buyer_profile", value: "company" }], {
      ...env,
      buyerProfile: "private",
    });
    expect(stored.settings.defaultBuyerProfile).toBe("company");
  });

  it("applies the .env ceilings on every read and warns when a stored value is above one", () => {
    const rows = [
      { key: "claude.daily_call_limit", value: 80 },
      { key: "claude.daily_spend_limit_usd", value: "8.00" },
    ];
    expect(resolveSettings(rows, env)).toMatchObject({
      settings: { claudeDailyCallLimit: 40, claudeDailySpendLimitMicrousd: 2_000_000 },
      warnings: [
        "Stored Claude call cap 80 is above the server ceiling 40; 40 applies.",
        "Stored Claude spend cap $8.00 is above the server ceiling $2.00; $2.00 applies.",
      ],
    });
    // A lowered .env wins over the code default without a warning: nothing is stored.
    const lowered = { ...env, claudeDailyCallLimit: 20, claudeDailySpendLimitMicrousd: 500_000 };
    expect(resolveSettings([], lowered)).toMatchObject({
      settings: { claudeDailyCallLimit: 20, claudeDailySpendLimitMicrousd: 500_000 },
      warnings: [],
    });
    expect(resolveSettings([{ key: "claude.daily_call_limit", value: 40 }], env).warnings).toEqual([]);
  });

  it("keeps the default and warns for a stored value no save would accept, and ignores unknown keys", () => {
    const rows = [
      { key: "claude.model", value: 5 },
      { key: "claude.effort", value: "max" },
      { key: "claude.daily_call_limit", value: -1 },
      { key: "claude.daily_spend_limit_usd", value: "2.005" },
      { key: "alerts.per_hour", value: 21 },
      { key: "alerts.per_day", value: 0 },
      { key: "alerts.default_buyer_profile", value: "reseller" },
      { key: "matcher.low_feedback_below", value: 10.5 },
      { key: "matcher.unknown", value: 1 },
    ];
    const resolved = resolveSettings(rows, env);
    expect(resolved.settings).toEqual(resolveSettings([], env).settings);
    expect(resolved.warnings).toHaveLength(8);
    expect(resolved.warnings[1]).toBe('Stored setting claude.effort is not valid (Choose low, medium or high.); the default "medium" applies.');
  });
});

describe("checkSetting", () => {
  it("accepts a value for saving, refuses one above its .env ceiling and unknown keys", () => {
    expect(checkSetting("claude.daily_call_limit", 40, env)).toEqual({ ok: true, value: 40 });
    expect(checkSetting("claude.daily_call_limit", 0, env)).toEqual({ ok: true, value: 0 });
    expect(checkSetting("claude.daily_call_limit", 41, env)).toEqual({
      ok: false,
      error: "The server ceiling is 40 calls a day (CLAUDE_DAILY_CALL_LIMIT).",
    });
    expect(checkSetting("claude.daily_spend_limit_usd", "1.5", env)).toEqual({ ok: true, value: "1.50" });
    expect(checkSetting("claude.daily_spend_limit_usd", "2.01", env)).toEqual({
      ok: false,
      error: "The server ceiling is $2.00 a day (CLAUDE_DAILY_SPEND_LIMIT_USD).",
    });
    expect(checkSetting("alerts.per_hour", 21, env)).toEqual({ ok: false, error: "Enter 1 to 20." });
    expect(checkSetting("claude.effort", "high", env)).toEqual({ ok: true, value: "high" });
    expect(checkSetting("claude.api_key", "x", env)).toEqual({ ok: false, error: "Unknown setting claude.api_key." });
  });

  it("treats names of object built-ins as unknown keys", () => {
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(checkSetting(key, 1, env)).toEqual({ ok: false, error: `Unknown setting ${key}.` });
      expect(resolveSettings([{ key, value: 1 }], env)).toEqual(resolveSettings([], env));
    }
  });
});

describe("checkModelChoice", () => {
  it("accepts only a model and effort pair that passed the eval for the current prompt version", () => {
    const passed = [
      { model: "claude-sonnet-5-5", effort: "medium" },
      { model: "claude-haiku-5-5", effort: "medium" },
    ] as const;
    expect(checkModelChoice({ model: "claude-haiku-5-5", effort: "medium" }, passed)).toEqual({ ok: true });
    expect(checkModelChoice({ model: "claude-haiku-5-5", effort: "high" }, passed)).toEqual({
      ok: false,
      error: "claude-haiku-5-5 at effort high has not passed the screening eval for the current prompt.",
    });
    expect(checkModelChoice({ model: "claude-sonnet-5-5", effort: "medium" }, []).ok).toBe(false);
  });
});

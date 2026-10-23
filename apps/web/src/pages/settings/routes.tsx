import { loadSettings, saveSettings, type DbPool, type LoadedSession, type SettingChange } from "@ebay-sniper/db";
import { checkSetting, formatUsd, type Clock, type ResolvedSettings, type Settings, type SettingsEnv } from "@ebay-sniper/domain";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../session.js";
import { errorPage } from "../errors/views.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import type { Child } from "../../ui/shared.js";
import type { ScreeningOption } from "./options.js";
import {
  AlertsFields,
  alertsReadOnly,
  alertsValues,
  ClaudeFields,
  claudeReadOnly,
  claudeValues,
  JunkRules,
  MatchingFields,
  matchingReadOnly,
  matchingValues,
  SectionForm,
  SectionReadOnly,
  type FieldErrors,
  type FieldValues,
  type ReadOnlyItem,
  type Section,
} from "./views.js";

// What the settings pages need from the app.
export type SettingsPageDeps = {
  pool: DbPool;
  clock: Clock;
  assets: AssetManifest;
  // The .env ceilings every Claude cap is held to (spec 2.5).
  settingsEnv: SettingsEnv;
  // The pairs that passed the eval for the current prompt version (spec 4.6).
  screeningOptions: readonly ScreeningOption[];
};

// The session guard lets only signed-in requests through to these routes.
function signedIn(c: Context<AppEnv>): LoadedSession {
  const session = c.get("session");
  if (session === null) throw new Error("the settings pages need a session");
  return session;
}

// The posted text of each field; a missing field is empty.
async function postedValues(c: Context<AppEnv>, fields: readonly string[]): Promise<FieldValues> {
  const body = await c.req.parseBody();
  return Object.fromEntries(fields.map((field) => [field, typeof body[field] === "string" ? body[field].trim() : ""]));
}

// A whole number is stored as a number; anything else goes to the setting's parser as it was
// typed, so the parser's own message says what is wrong.
const wholeOrText = (text: string): unknown => (/^\d{1,9}$/.test(text) ? Number(text) : text);

// The settings in force in their stored form, by key.
const inForce = (settings: Settings): Record<string, unknown> => ({
  "claude.model": settings.claudeModel,
  "claude.effort": settings.claudeEffort,
  "claude.daily_call_limit": settings.claudeDailyCallLimit,
  "claude.daily_spend_limit_usd": formatUsd(settings.claudeDailySpendLimitMicrousd).slice(1),
  "alerts.per_hour": settings.alertsPerHour,
  "alerts.per_day": settings.alertsPerDay,
  "alerts.default_buyer_profile": settings.defaultBuyerProfile,
  "matcher.low_feedback_below": settings.lowFeedbackBelow,
});

// A save writes, audits and versions only what changed ("1.5" is the stored "1.50"). Compared
// with the stored row where there is one, so saving a cap stored above the .env ceiling, which the
// page shows at the ceiling, stores the cap that applies.
async function changedOnly(db: DbPool, changes: readonly SettingChange[], settings: Settings, env: SettingsEnv): Promise<SettingChange[]> {
  const result = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM app.setting");
  const current = { ...inForce(settings), ...Object.fromEntries(result.rows.map((row) => [row.key, row.value])) };
  return changes.filter((change) => {
    const check = checkSetting(change.key, change.value, env);
    return JSON.stringify(check.ok ? check.value : change.value) !== JSON.stringify(current[change.key]);
  });
}

// Model and effort are one field on the page.
const fieldOf = (key: string): string => (key === "claude.model" || key === "claude.effort" ? "choice" : key);

// One section page: its fields, how the settings fill them, what a post changes, and the form.
type SectionSpec = {
  fields: readonly string[];
  values: (settings: Settings) => FieldValues;
  readOnly: (settings: Settings) => ReadOnlyItem[];
  // Shown to editors under the values.
  readOnlyExtra?: Child;
  changes: (values: FieldValues) => SettingChange[];
  form: (input: { settings: Settings; values: FieldValues; errors: FieldErrors }) => Child;
};

export function settingsRoutes(deps: SettingsPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  const sections: Record<Section, SectionSpec> = {
    claude: {
      fields: ["choice", "claude.daily_call_limit", "claude.daily_spend_limit_usd"],
      values: claudeValues,
      readOnly: claudeReadOnly,
      changes: (values) => {
        const caps = [
          { key: "claude.daily_call_limit", value: wholeOrText(values["claude.daily_call_limit"] ?? "") },
          { key: "claude.daily_spend_limit_usd", value: values["claude.daily_spend_limit_usd"] ?? "" },
        ];
        // No choice is posted while no pair has passed the eval: model and effort stay as they are.
        const choice = values["choice"] ?? "";
        if (choice === "") return caps;
        const [model = "", effort = ""] = choice.split(":");
        return [{ key: "claude.model", value: model }, { key: "claude.effort", value: effort }, ...caps];
      },
      form: ({ settings, values, errors }) => (
        <ClaudeFields settings={settings} env={deps.settingsEnv} options={deps.screeningOptions} values={values} errors={errors} />
      ),
    },
    alerts: {
      fields: ["alerts.per_hour", "alerts.per_day", "alerts.default_buyer_profile"],
      values: alertsValues,
      readOnly: alertsReadOnly,
      changes: (values) => [
        { key: "alerts.per_hour", value: wholeOrText(values["alerts.per_hour"] ?? "") },
        { key: "alerts.per_day", value: wholeOrText(values["alerts.per_day"] ?? "") },
        { key: "alerts.default_buyer_profile", value: values["alerts.default_buyer_profile"] ?? "" },
      ],
      form: ({ values, errors }) => <AlertsFields values={values} errors={errors} />,
    },
    matching: {
      fields: ["matcher.low_feedback_below"],
      values: matchingValues,
      readOnly: matchingReadOnly,
      readOnlyExtra: <JunkRules />,
      changes: (values) => [{ key: "matcher.low_feedback_below", value: wholeOrText(values["matcher.low_feedback_below"] ?? "") }],
      form: ({ values, errors }) => <MatchingFields values={values} errors={errors} />,
    },
  };

  const page = (c: Context<AppEnv>, children: Child) => renderPage(c, deps, { title: "Settings", active: "settings", children });

  const showForm = (
    c: Context<AppEnv>,
    section: Section,
    { settings, warnings }: ResolvedSettings,
    values: FieldValues,
    errors: FieldErrors,
    refusal: string | null = null,
  ) =>
    page(
      c,
      <SectionForm section={section} warnings={warnings} refusal={refusal} csrf={signedIn(c).session.csrfSecret}>
        {sections[section].form({ settings, values, errors })}
      </SectionForm>,
    );

  const mount = (path: string, section: Section) => {
    const spec = sections[section];

    routes.get(path, async (c) => {
      const resolved = await loadSettings(deps.pool, deps.settingsEnv);
      if (signedIn(c).person.role !== "admin") {
        return c.html(
          page(
            c,
            <SectionReadOnly section={section} warnings={resolved.warnings} items={spec.readOnly(resolved.settings)}>
              {spec.readOnlyExtra}
            </SectionReadOnly>,
          ),
        );
      }
      return c.html(showForm(c, section, resolved, spec.values(resolved.settings), {}));
    });

    routes.post(path, async (c) => {
      const session = signedIn(c);
      // Spec 7.7: editors see the settings but cannot change them.
      if (session.person.role !== "admin") return c.html(errorPage({ status: 403, assets: deps.assets }), 403);
      const values = await postedValues(c, spec.fields);
      const before = await loadSettings(deps.pool, deps.settingsEnv);
      const result = await saveSettings(
        deps.pool,
        await changedOnly(deps.pool, spec.changes(values), before.settings, deps.settingsEnv),
        { at: deps.clock.now(), actor: `user:${session.person.id}`, userId: session.person.id, env: deps.settingsEnv },
        deps.screeningOptions,
      );
      if (!result.ok && result.reason === "invalid") {
        const errors = Object.fromEntries(result.errors.map((error) => [fieldOf(error.key), error.error]));
        return c.html(showForm(c, section, await loadSettings(deps.pool, deps.settingsEnv), values, errors), 422);
      }
      if (!result.ok) {
        const refusal = `The daily call plan would be ${result.plan.total.toLocaleString("en-US")} of ${result.plan.ceiling.toLocaleString("en-US")} eBay calls. Nothing was saved.`;
        return c.html(showForm(c, section, await loadSettings(deps.pool, deps.settingsEnv), values, {}, refusal), 422);
      }
      return c.redirect(c.req.path, 303);
    });
  };

  mount("/", "claude");
  mount("/alerts", "alerts");
  mount("/matching", "matching");

  return routes;
}

import { DEFAULT_JUNK_RULES, formatUsd, type JunkRule, type Settings, type SettingsEnv } from "@ebay-sniper/domain";
import { Button } from "../../ui/core.js";
import { DescriptionList, Table } from "../../ui/data.js";
import { Banner, Callout } from "../../ui/feedback.js";
import { Fieldset, Input, RadioGroup } from "../../ui/forms.js";
import { PageHeader, Tabs } from "../../ui/navigation.js";
import type { Child } from "../../ui/shared.js";
import { outcomeLabel } from "../products/format.js";
import { checksCovered, formatEvalDay, formatPerCheck, modelLabel, optionValue, type ScreeningOption } from "./options.js";

// What the form fields show: the settings in force, or what was posted. Keyed by field name.
export type FieldValues = Record<string, string>;
// One message per field name.
export type FieldErrors = Record<string, string>;

// Spec 8.3: Settings has the sections Claude, Alerts and Matching, each its own page.
export type Section = "claude" | "alerts" | "matching";

const SECTIONS: { value: Section; label: string; href: string }[] = [
  { value: "claude", label: "Claude", href: "/settings" },
  { value: "alerts", label: "Alerts", href: "/settings/alerts" },
  { value: "matching", label: "Matching", href: "/settings/matching" },
];

export const sectionHref = (section: Section): string => SECTIONS.find((entry) => entry.value === section)?.href ?? "/settings";

function SettingsHeader({ section, warnings }: { section: Section; warnings: readonly string[] }) {
  return (
    <>
      <PageHeader title="Settings" tabs={<Tabs label="Settings sections" value={section} tabs={SECTIONS} />} />
      {warnings.map((warning) => (
        <Banner tone="warning">{warning}</Banner>
      ))}
    </>
  );
}

export type SectionFormProps = {
  section: Section;
  // Stored values that do not apply as stored (spec 2.5), from resolveSettings.
  warnings: readonly string[];
  // Why the last save was refused as a whole (the daily call plan, spec 5.3), or null.
  refusal: string | null;
  csrf: string;
  children: Child;
};

// One section's form with its one primary button (spec 8.2).
export function SectionForm({ section, warnings, refusal, csrf, children }: SectionFormProps) {
  return (
    <>
      <SettingsHeader section={section} warnings={warnings} />
      {refusal !== null && <Callout tone="danger">{refusal}</Callout>}
      <form method="post" action={sectionHref(section)} class="app-stack">
        <input type="hidden" name="_csrf" value={csrf} />
        {children}
        <div class="app-row">
          <Button type="submit" variant="primary">
            Save settings
          </Button>
        </div>
      </form>
    </>
  );
}

export type ReadOnlyItem = { label: string; value: string; numeric?: boolean };

// What editors see (spec 7.7): the values in force, no form.
export function SectionReadOnly({ section, warnings, items, children }: { section: Section; warnings: readonly string[]; items: ReadOnlyItem[]; children?: Child }) {
  return (
    <>
      <SettingsHeader section={section} warnings={warnings} />
      <Callout>Only admins can change settings.</Callout>
      <DescriptionList items={items} />
      {children}
    </>
  );
}

// The Claude fields as the settings in force fill them.
export function claudeValues(settings: Settings): FieldValues {
  return {
    choice: optionValue({ model: settings.claudeModel, effort: settings.claudeEffort }),
    "claude.daily_call_limit": String(settings.claudeDailyCallLimit),
    "claude.daily_spend_limit_usd": formatUsd(settings.claudeDailySpendLimitMicrousd).slice(1),
  };
}

export const claudeReadOnly = (settings: Settings): ReadOnlyItem[] => [
  { label: "Model and effort", value: `${modelLabel(settings.claudeModel)}, ${settings.claudeEffort} effort` },
  { label: "Claude checks a day", value: String(settings.claudeDailyCallLimit), numeric: true },
  { label: "Claude spend a day", value: formatUsd(settings.claudeDailySpendLimitMicrousd), numeric: true },
];

export type ClaudeFieldsProps = {
  settings: Settings;
  env: SettingsEnv;
  options: readonly ScreeningOption[];
  values: FieldValues;
  errors: FieldErrors;
};

// Spec 8.3 Settings, Claude: one card per pair that passed the eval (spec 4.6), with what a check
// can cost at worst and how many checks the spend cap pays for.
export function ClaudeFields({ settings, env, options, values, errors }: ClaudeFieldsProps) {
  const spend = formatUsd(settings.claudeDailySpendLimitMicrousd);
  return (
    <Fieldset legend="Claude check">
      {options.length === 0 ? (
        <Callout tone="warning">
          {`No model has passed the screening eval for the current prompt yet. The Claude check uses ${modelLabel(settings.claudeModel)}, ${settings.claudeEffort} effort.`}
        </Callout>
      ) : (
        <RadioGroup
          name="choice"
          legend="Model and effort"
          variant="cards"
          value={values["choice"] ?? ""}
          options={options.map((option) => ({
            value: optionValue(option),
            label: `${modelLabel(option.model)}, ${option.effort} effort`,
            description: `Eval passed ${formatEvalDay(option.passedOn)}. Worst case ${formatPerCheck(option.worstCaseMicrousd)} a check. ${spend} covers ${String(checksCovered(settings.claudeDailySpendLimitMicrousd, option))} checks; your call cap is ${String(settings.claudeDailyCallLimit)}.`,
          }))}
        />
      )}
      {errors["choice"] !== undefined && <Callout tone="danger">{errors["choice"]}</Callout>}
      <Input
        id="claude-call-limit"
        name="claude.daily_call_limit"
        label="Claude checks a day"
        inputmode="numeric"
        value={values["claude.daily_call_limit"] ?? ""}
        error={errors["claude.daily_call_limit"]}
        hint={`At most ${String(env.claudeDailyCallLimit)}, the server ceiling (CLAUDE_DAILY_CALL_LIMIT). 0 turns the Claude check off.`}
      />
      <Input
        id="claude-spend-limit"
        name="claude.daily_spend_limit_usd"
        label="Claude spend a day (USD)"
        inputmode="decimal"
        value={values["claude.daily_spend_limit_usd"] ?? ""}
        error={errors["claude.daily_spend_limit_usd"]}
        hint={`At most ${formatUsd(env.claudeDailySpendLimitMicrousd)}, the server ceiling (CLAUDE_DAILY_SPEND_LIMIT_USD).`}
      />
    </Fieldset>
  );
}

export function alertsValues(settings: Settings): FieldValues {
  return {
    "alerts.per_hour": String(settings.alertsPerHour),
    "alerts.per_day": String(settings.alertsPerDay),
    "alerts.default_buyer_profile": settings.defaultBuyerProfile,
  };
}

export const matchingValues = (settings: Settings): FieldValues => ({ "matcher.low_feedback_below": String(settings.lowFeedbackBelow) });

export const matchingReadOnly = (settings: Settings): ReadOnlyItem[] => [
  { label: "Low seller feedback below", value: String(settings.lowFeedbackBelow), numeric: true },
];

// The junk rules every product gets unless it turns one off (spec 3.3). Changed by pull request
// only, so shown, never edited.
export function JunkRules() {
  return (
    <Table<JunkRule>
      caption="Default junk rules"
      columns={[
        { key: "id", label: "Rule", rowHeader: true, mono: true, render: (rule) => rule.id },
        { key: "reason", label: "Filters out", render: (rule) => outcomeLabel(rule.reason).label },
        { key: "entries", label: "Words", render: (rule) => rule.entries.join(", ") },
        { key: "allow", label: "Except", render: (rule) => (rule.allow.length === 0 ? "None" : rule.allow.join(", ")) },
      ]}
      rows={[...DEFAULT_JUNK_RULES]}
    />
  );
}

// Spec 8.3 Settings, Matching: the low-feedback threshold, and the junk list read-only.
export function MatchingFields({ values, errors }: { values: FieldValues; errors: FieldErrors }) {
  return (
    <>
      <Fieldset legend="Matching">
        <Input
          id="low-feedback"
          name="matcher.low_feedback_below"
          label="Low seller feedback below"
          inputmode="numeric"
          value={values["matcher.low_feedback_below"] ?? ""}
          error={errors["matcher.low_feedback_below"]}
          hint="A seller with fewer ratings is flagged in the alert. 0 to 1000; 0 flags nobody."
        />
      </Fieldset>
      <Fieldset legend="Default junk rules" description="Every product uses these unless it turns a rule off. They change by pull request only.">
        <JunkRules />
      </Fieldset>
    </>
  );
}

export const alertsReadOnly =(settings: Settings): ReadOnlyItem[] => [
  { label: "Alerts an hour", value: String(settings.alertsPerHour), numeric: true },
  { label: "Alerts a day", value: String(settings.alertsPerDay), numeric: true },
  { label: "Default buyer profile for new products", value: settings.defaultBuyerProfile === "company" ? "Company" : "Private" },
];

// Spec 8.3 Settings, Alerts: how many mails may go out, and whose prices a new product shows.
export function AlertsFields({ values, errors }: { values: FieldValues; errors: FieldErrors }) {
  return (
    <Fieldset legend="Alerts">
      <Input
        id="alerts-per-hour"
        name="alerts.per_hour"
        label="Alerts an hour"
        inputmode="numeric"
        value={values["alerts.per_hour"] ?? ""}
        error={errors["alerts.per_hour"]}
        hint="1 to 20."
      />
      <Input
        id="alerts-per-day"
        name="alerts.per_day"
        label="Alerts a day"
        inputmode="numeric"
        value={values["alerts.per_day"] ?? ""}
        error={errors["alerts.per_day"]}
        hint="1 to 100."
      />
      <RadioGroup
        name="alerts.default_buyer_profile"
        legend="Default buyer profile for new products"
        value={values["alerts.default_buyer_profile"] ?? ""}
        options={[
          { value: "company", label: "Company", description: "The alert says whether the seller gives a VAT invoice." },
          { value: "private", label: "Private", description: "The alert leaves VAT out. Prices are compared gross either way." },
        ]}
      />
    </Fieldset>
  );
}

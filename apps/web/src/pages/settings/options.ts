import type { ClaudeEffort } from "@ebay-sniper/domain";

// Spec 4.6: one (model, effort) pair that passed the screening eval for the current prompt
// version. start.ts builds the list from packages/llm (SCREENING_EVALS, worstCaseCostMicrousd), so
// the pages need no import of the Claude client.
export type ScreeningOption = {
  model: string;
  effort: ClaudeEffort;
  // The day of the eval run, "2026-10-20".
  passedOn: string;
  // The most one check can cost on this model, in micro-USD.
  worstCaseMicrousd: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "claude-sonnet-5-5" as "Sonnet 5.5".
export function modelLabel(model: string): string {
  const [family = model, ...version] = model.replace(/^claude-/, "").split("-");
  return [family.charAt(0).toUpperCase() + family.slice(1), version.join(".")].filter((part) => part !== "").join(" ");
}

// "2026-10-20" as "20 Oct 2026".
export function formatEvalDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `${String(date)} ${MONTHS[(month ?? 1) - 1] ?? ""} ${String(year)}`;
}

// A worst case in dollars to the tenth of a cent, rounded up: "$0.067", "$0.004".
export function formatPerCheck(microusd: number): string {
  return `$${(Math.ceil(microusd / 1000) / 1000).toFixed(3)}`;
}

// How many checks the daily spend cap pays for at the worst case of each.
export const checksCovered = (spendMicrousd: number, option: ScreeningOption): number =>
  Math.floor(spendMicrousd / option.worstCaseMicrousd);

export const optionValue = (option: Pick<ScreeningOption, "model" | "effort">): string => `${option.model}:${option.effort}`;

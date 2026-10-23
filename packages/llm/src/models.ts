import type { ClaudeEffort, ModelChoice, Settings } from "@ebay-sniper/domain";
import type { TokenUsage } from "./cost.js";
import { PROMPT_VERSION } from "./prompt.js";
import { WORST_CASE_INPUT_TOKENS, WORST_CASE_OUTPUT_TOKENS } from "./screening-config.v1.js";

// Spec 4.6: the models Settings may choose for the Claude check. Prices are USD per million tokens
// in micro-USD, the standard first-party rates with global inference (inference_geo "global"),
// from https://platform.claude.com/docs/en/about-claude/pricing. Haiku's rate holds for prompts up
// to 100,000 tokens; one screening call sends at most 18,500. xhigh and max are left out: thinking
// counts against MAX_TOKENS (3,000).
export const PRICES_CHECKED_ON = "2026-10-22";

export type ScreeningModel = {
  id: string;
  inputMicrousdPerMillion: number;
  outputMicrousdPerMillion: number;
  efforts: readonly ClaudeEffort[];
};

export const SCREENING_MODELS = [
  { id: "claude-sonnet-5-5", inputMicrousdPerMillion: 2_000_000, outputMicrousdPerMillion: 10_000_000, efforts: ["low", "medium", "high"] },
  { id: "claude-haiku-5-5", inputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 500_000, efforts: ["low", "medium", "high"] },
  { id: "claude-opus-5-5", inputMicrousdPerMillion: 4_000_000, outputMicrousdPerMillion: 20_000_000, efforts: ["low", "medium", "high"] },
] as const satisfies readonly ScreeningModel[];

export type ScreeningModelId = (typeof SCREENING_MODELS)[number]["id"];

// One entry per (model, effort, prompt version) that passed the offline eval, added by pull
// request after the run (V7). Settings offers only these pairs for the current prompt version.
export type ScreeningEval = { model: ScreeningModelId; effort: ClaudeEffort; promptVersion: string; passedOn: string };

// The V7 run of 2026-10-23, one run per pair, recorded in evals/results/screen-v2-0f3e9cd25991.json.
// Haiku high failed (2 of 6 v2 legitimate cases answered caution) and is not offered.
export const SCREENING_EVALS: readonly ScreeningEval[] = [
  { model: "claude-sonnet-5-5", effort: "low", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-sonnet-5-5", effort: "medium", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-sonnet-5-5", effort: "high", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-haiku-5-5", effort: "low", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-haiku-5-5", effort: "medium", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-opus-5-5", effort: "low", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-opus-5-5", effort: "medium", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
  { model: "claude-opus-5-5", effort: "high", promptVersion: "screen-v2:0f3e9cd25991", passedOn: "2026-10-23" },
];

// The pairs for checkModelChoice and the Settings page.
export function passedChoices(promptVersion: string, evals: readonly ScreeningEval[] = SCREENING_EVALS): ModelChoice[] {
  return evals.filter((entry) => entry.promptVersion === promptVersion).map(({ model, effort }) => ({ model, effort }));
}

export function screeningModel(id: string): ScreeningModel | undefined {
  return SCREENING_MODELS.find((model) => model.id === id);
}

const MILLION = 1_000_000;

function modelOf(id: ScreeningModelId): ScreeningModel {
  const model = screeningModel(id);
  if (model === undefined) throw new Error(`unknown screening model ${id}`);
  return model;
}

// Tokens x price / 1,000,000, rounded up to a whole micro-USD. Output tokens include thinking.
export function costMicroUsd(id: ScreeningModelId, usage: TokenUsage): number {
  const model = modelOf(id);
  return Math.ceil((usage.inputTokens * model.inputMicrousdPerMillion + usage.outputTokens * model.outputMicrousdPerMillion) / MILLION);
}

// The most one call can cost on this model (spec 4.2), reserved before the call.
export function worstCaseCostMicrousd(id: ScreeningModelId): number {
  return costMicroUsd(id, { inputTokens: WORST_CASE_INPUT_TOKENS, outputTokens: WORST_CASE_OUTPUT_TOKENS });
}

export type ScreeningChoice = {
  promptVersion: string;
  model: ScreeningModelId;
  effort: ClaudeEffort;
  // Where the model and effort came from.
  source: "candidate" | "settings" | "default";
};

// The code default of claude.model and claude.effort (settings.ts).
const DEFAULT_CHOICE = { model: "claude-sonnet-5-5", effort: "medium" } as const;

type Pair = { model: ScreeningModelId; effort: ClaudeEffort };

function runnable(model: string | null, effort: string | null): Pair | null {
  const found = SCREENING_MODELS.find((entry) => entry.id === model);
  const level = found?.efforts.find((entry) => entry === effort);
  return found === undefined || level === undefined ? null : { model: found.id, effort: level };
}

// Spec 4.5: screen and its retry use the prompt version, model and effort enrich fixed on the
// candidate at the hand-off. A candidate without them, or with values this release cannot run,
// takes the settings read now; a stored setting this release cannot run, or one that did not pass
// the eval for this prompt version (spec 4.6), takes the code default.
export function screeningChoice(
  fixed: { promptVersion: string | null; model: string | null; effort: string | null },
  settings: Pick<Settings, "claudeModel" | "claudeEffort">,
): ScreeningChoice {
  const onCandidate = fixed.promptVersion === PROMPT_VERSION ? runnable(fixed.model, fixed.effort) : null;
  if (onCandidate !== null) return { promptVersion: PROMPT_VERSION, ...onCandidate, source: "candidate" };
  const setting = runnable(settings.claudeModel, settings.claudeEffort);
  const passed = passedChoices(PROMPT_VERSION).some((pair) => pair.model === setting?.model && pair.effort === setting.effort);
  if (setting !== null && passed) return { promptVersion: PROMPT_VERSION, ...setting, source: "settings" };
  return { promptVersion: PROMPT_VERSION, ...DEFAULT_CHOICE, source: "default" };
}

// Settings shows it per choice: "$2.00 covers 29 checks on Sonnet, 14 on Opus" (spec 4.6).
export function checksCovered(spendLimitMicrousd: number, id: ScreeningModelId): number {
  return Math.floor(spendLimitMicrousd / worstCaseCostMicrousd(id));
}

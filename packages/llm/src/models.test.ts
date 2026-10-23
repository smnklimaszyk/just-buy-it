import { describe, expect, it } from "vitest";
import {
  PRICES_CHECKED_ON,
  SCREENING_EVALS,
  SCREENING_MODELS,
  checksCovered,
  costMicroUsd,
  passedChoices,
  screeningChoice,
  screeningModel,
  worstCaseCostMicrousd,
} from "./models.js";
import { PROMPT_VERSION } from "./prompt.js";

describe("screening models (spec 4.6)", () => {
  it("lists Sonnet, Haiku and Opus 5.5 with the prices of the Anthropic pricing page and efforts up to high", () => {
    expect(SCREENING_MODELS).toEqual([
      { id: "claude-sonnet-5-5", inputMicrousdPerMillion: 2_000_000, outputMicrousdPerMillion: 10_000_000, efforts: ["low", "medium", "high"] },
      { id: "claude-haiku-5-5", inputMicrousdPerMillion: 100_000, outputMicrousdPerMillion: 500_000, efforts: ["low", "medium", "high"] },
      { id: "claude-opus-5-5", inputMicrousdPerMillion: 4_000_000, outputMicrousdPerMillion: 20_000_000, efforts: ["low", "medium", "high"] },
    ]);
    expect(PRICES_CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screeningModel("claude-haiku-5-5")?.inputMicrousdPerMillion).toBe(100_000);
    expect(screeningModel("claude-sonnet-5")).toBeUndefined();
  });

  it("prices a call as tokens x price / 1,000,000, thinking in the output, rounded up to a micro-USD", () => {
    expect(costMicroUsd("claude-sonnet-5-5", { inputTokens: 2400, outputTokens: 1100 })).toBe(2400 * 2 + 1100 * 10);
    expect(costMicroUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 0 })).toBe(0);
    // 7 x 0.1 + 1 x 0.5 = 1.2, rounded up.
    expect(costMicroUsd("claude-haiku-5-5", { inputTokens: 7, outputTokens: 1 })).toBe(2);
  });

  it("bounds one call at 18,500 input and 3,000 output tokens: $0.067 on Sonnet, $0.0034 on Haiku, $0.134 on Opus", () => {
    expect(worstCaseCostMicrousd("claude-sonnet-5-5")).toBe(67_000);
    // 18,500 x 0.1 + 3,000 x 0.5 = 3,350 micro-USD.
    expect(worstCaseCostMicrousd("claude-haiku-5-5")).toBe(3_350);
    expect(worstCaseCostMicrousd("claude-opus-5-5")).toBe(134_000);
  });

  it("says how many worst-case checks a spend cap covers", () => {
    // "$2.00 covers 29 checks on Sonnet, 14 on Opus."
    expect(checksCovered(2_000_000, "claude-sonnet-5-5")).toBe(29);
    expect(checksCovered(2_000_000, "claude-opus-5-5")).toBe(14);
    expect(checksCovered(2_000_000, "claude-haiku-5-5")).toBe(597);
    expect(checksCovered(0, "claude-sonnet-5-5")).toBe(0);
  });

  it("offers only the (model, effort) pairs that passed the eval for the given prompt version", () => {
    const evals = [
      { model: "claude-sonnet-5-5", effort: "medium", promptVersion: "screen-v2:aaaaaaaaaaaa", passedOn: "2026-10-23" },
      { model: "claude-haiku-5-5", effort: "medium", promptVersion: "screen-v2:bbbbbbbbbbbb", passedOn: "2026-10-23" },
    ] as const;
    expect(passedChoices("screen-v2:aaaaaaaaaaaa", evals)).toEqual([{ model: "claude-sonnet-5-5", effort: "medium" }]);
    expect(passedChoices("screen-v2:cccccccccccc", evals)).toEqual([]);
    // The V7 run on 2026-10-23 (evals/results): every pair passed except Haiku high.
    expect(passedChoices(PROMPT_VERSION)).toEqual([
      { model: "claude-sonnet-5-5", effort: "low" },
      { model: "claude-sonnet-5-5", effort: "medium" },
      { model: "claude-sonnet-5-5", effort: "high" },
      { model: "claude-haiku-5-5", effort: "low" },
      { model: "claude-haiku-5-5", effort: "medium" },
      { model: "claude-opus-5-5", effort: "low" },
      { model: "claude-opus-5-5", effort: "medium" },
      { model: "claude-opus-5-5", effort: "high" },
    ]);
    expect(SCREENING_EVALS.every((entry) => entry.passedOn === "2026-10-23")).toBe(true);
  });
});

describe("screeningChoice (spec 4.5)", () => {
  const settings = { claudeModel: "claude-haiku-5-5", claudeEffort: "low" } as const;
  const none = { promptVersion: null, model: null, effort: null };

  it("takes the prompt version, model and effort fixed on the candidate, else the setting, else the default", () => {
    expect(screeningChoice({ promptVersion: PROMPT_VERSION, model: "claude-opus-5-5", effort: "high" }, settings)).toEqual({
      promptVersion: PROMPT_VERSION,
      model: "claude-opus-5-5",
      effort: "high",
      source: "candidate",
    });
    // Nothing fixed yet (a candidate handed over before enrich wrote them): the setting of now.
    expect(screeningChoice(none, settings)).toEqual({
      promptVersion: PROMPT_VERSION,
      model: "claude-haiku-5-5",
      effort: "low",
      source: "settings",
    });
    // Fixed on a prompt this release no longer has, or on a model or effort it cannot run.
    for (const fixed of [
      { promptVersion: "screen-v1:d8fab13d9ca1", model: "claude-sonnet-5-5", effort: "medium" },
      { promptVersion: PROMPT_VERSION, model: "claude-sonnet-5", effort: "medium" },
      { promptVersion: PROMPT_VERSION, model: "claude-sonnet-5-5", effort: "max" },
    ]) {
      expect(screeningChoice(fixed, settings).source).toBe("settings");
    }
    // A stored model this release cannot run (written by SQL): the code default.
    expect(screeningChoice(none, { claudeModel: "claude-sonnet-5", claudeEffort: "medium" })).toEqual({
      promptVersion: PROMPT_VERSION,
      model: "claude-sonnet-5-5",
      effort: "medium",
      source: "default",
    });
  });

  it("takes the code default for a stored pair that did not pass the eval for this prompt version (spec 4.6)", () => {
    // Haiku high failed V7; it can only be stored by hand-written SQL or by a release before a prompt change.
    expect(screeningChoice(none, { claudeModel: "claude-haiku-5-5", claudeEffort: "high" })).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "medium",
      source: "default",
    });
  });
});

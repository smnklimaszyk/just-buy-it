// @ebay-sniper/llm/catalog: the model list, the eval results and the prompt version, without the
// Claude adapter. The web Settings page and the ops CLI read these; only the worker calls Claude
// (ADR 0007, ADR 0039).
export { PROMPT_VERSION } from "./prompt.js";
export {
  checksCovered,
  passedChoices,
  SCREENING_EVALS,
  SCREENING_MODELS,
  worstCaseCostMicrousd,
  type ScreeningEval,
  type ScreeningModelId,
} from "./models.js";

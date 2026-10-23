import { createHash } from "node:crypto";
import { MAX_PRODUCT_BLOCK_BYTES } from "@ebay-sniper/domain";
import { SYSTEM_PROMPT } from "./prompt.v2.js";
import { ANSWER_JSON_SCHEMA } from "./schema.js";
import { MAX_TOKENS, MAX_USER_MESSAGE_BYTES } from "./screening-config.v1.js";

export type PromptVersionParts = {
  systemPrompt: string;
  schema: object;
  maxTokens: number;
  maxUserMessageBytes: number;
  maxProductBlockBytes: number;
};

// A hash over the fixed parts that shape the answer. It is part of the screening claim key, so
// any change screens a listing again instead of reusing an old result. Model and effort are not
// in it: the eval gate is keyed on (model, effort, prompt version) (spec 4.6), and the candidate
// keeps the model and effort it was handed with (spec 4.5).
export function promptVersion(parts: PromptVersionParts): string {
  const hashed = JSON.stringify([
    parts.systemPrompt,
    JSON.stringify(parts.schema),
    parts.maxTokens,
    parts.maxUserMessageBytes,
    parts.maxProductBlockBytes,
  ]);
  return `screen-v2:${createHash("sha256").update(hashed).digest("hex").slice(0, 12)}`;
}

export const PROMPT_VERSION = promptVersion({
  systemPrompt: SYSTEM_PROMPT,
  schema: ANSWER_JSON_SCHEMA,
  maxTokens: MAX_TOKENS,
  maxUserMessageBytes: MAX_USER_MESSAGE_BYTES,
  maxProductBlockBytes: MAX_PRODUCT_BLOCK_BYTES,
});

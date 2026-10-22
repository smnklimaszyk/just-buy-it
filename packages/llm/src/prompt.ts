import { createHash } from "node:crypto";
import { SYSTEM_PROMPT } from "./prompt.v1.js";
import { ANSWER_JSON_SCHEMA } from "./schema.js";
import { EFFORT, MAX_TOKENS, MAX_USER_MESSAGE_BYTES, MODEL } from "./screening-config.v1.js";

export type PromptVersionParts = {
  systemPrompt: string;
  schema: object;
  model: string;
  effort: string;
  maxTokens: number;
  maxUserMessageBytes: number;
};

// Section 5.3: a hash over everything that shapes the answer. It is part of the screening claim
// key, so any change screens a listing again instead of reusing an old result.
export function promptVersion(parts: PromptVersionParts): string {
  const hashed = JSON.stringify([
    parts.systemPrompt,
    JSON.stringify(parts.schema),
    parts.model,
    parts.effort,
    parts.maxTokens,
    parts.maxUserMessageBytes,
  ]);
  return `screen-v1:${createHash("sha256").update(hashed).digest("hex").slice(0, 12)}`;
}

export const PROMPT_VERSION = promptVersion({
  systemPrompt: SYSTEM_PROMPT,
  schema: ANSWER_JSON_SCHEMA,
  model: MODEL,
  effort: EFFORT,
  maxTokens: MAX_TOKENS,
  maxUserMessageBytes: MAX_USER_MESSAGE_BYTES,
});

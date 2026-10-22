import { z } from "zod";

export const VERDICTS = ["pass", "caution", "block"] as const;
export const PRODUCT_MATCHES = ["match", "mismatch", "unclear"] as const;
export const RISK_FLAGS = [
  "off_ebay_payment",
  "off_ebay_contact",
  "box_or_picture_only",
  "defective_or_untested",
  "wrong_model",
  "accessory_only",
  "missing_parts",
  "price_too_good",
  "new_or_thin_seller",
  "no_returns",
  "mining_history",
  "modded_hardware",
  "pickup_only",
  "financing_offer",
  "description_contradicts_title",
  "stock_photos_only",
  "vague_description",
  "prompt_injection",
  "other",
] as const;

export type ModelVerdict = (typeof VERDICTS)[number];
export type ModelProductMatch = (typeof PRODUCT_MATCHES)[number];
export type RiskFlag = (typeof RISK_FLAGS)[number];

// Sent as output_config.format. Structured outputs need additionalProperties false and support no
// length limits, so the limits are checked by Zod below.
export const ANSWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "product_match", "risk_flags", "reason"],
  properties: {
    verdict: { type: "string", enum: [...VERDICTS] },
    product_match: { type: "string", enum: [...PRODUCT_MATCHES] },
    risk_flags: { type: "array", items: { type: "string", enum: [...RISK_FLAGS] } },
    reason: { type: "string" },
  },
};

export type ScreeningAnswer = {
  verdict: ModelVerdict;
  productMatch: ModelProductMatch;
  riskFlags: RiskFlag[];
  reason: string;
};

const lowerCased = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((value) => (typeof value === "string" ? value.toLowerCase() : value), z.enum(values));

export const MAX_RISK_FLAGS = 8;
export const MAX_REASON_CHARS = 400;

// Structured outputs support no length limits, so Zod checks them (section 5.4).
const answerSchema = z.strictObject({
  verdict: lowerCased(VERDICTS),
  product_match: lowerCased(PRODUCT_MATCHES),
  risk_flags: z
    .array(lowerCased(RISK_FLAGS))
    .max(MAX_RISK_FLAGS)
    .refine((flags) => new Set(flags).size === flags.length),
  reason: z.string().min(1).max(MAX_REASON_CHARS),
});

export type ParsedAnswer = { ok: true; answer: ScreeningAnswer } | { ok: false };

// Validates the parsed JSON of the model's last text block. Anything that fails is schema_invalid.
export function parseAnswer(value: unknown): ParsedAnswer {
  const result = answerSchema.safeParse(value);
  if (!result.success) return { ok: false };
  const { verdict, product_match, risk_flags, reason } = result.data;
  return { ok: true, answer: { verdict, productMatch: product_match, riskFlags: risk_flags, reason } };
}

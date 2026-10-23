import { CONDITION_GROUPS, matchListing, type ProductRules } from "@ebay-sniper/domain";
import { outcomeLabel } from "./format.js";

// Spec 8.4 "Test a title": the product's rules (spec 3.4 steps 1 to 6) on one typed title, as a
// fixed-price listing in the product's first condition. No price is typed, so the band never
// decides; the result names the outcome and the rule that fired.

export type TitleCheck = { tone: "success" | "warning"; text: string };

const OPEN_BAND = { limitCents: Number.MAX_SAFE_INTEGER, floorCents: 0 };

export function checkTitle(rules: ProductRules, title: string): TitleCheck {
  const result = matchListing(
    {
      title,
      currency: "EUR",
      priceCents: 0,
      landedCents: 0,
      shippingKnown: true,
      buyingOptions: ["FIXED_PRICE"],
      itemGroup: false,
      conditionId: rules.conditionIds[0] ?? null,
      conditionText: null,
      seller: { feedbackScore: null },
    },
    [{ key: "draft", ...rules, limits: Object.fromEntries(CONDITION_GROUPS.map((group) => [group, OPEN_BAND])) }],
    { lowFeedbackBelow: 0 },
  );
  if (result.outcome === "candidate") return { tone: "success", text: "Matches your rules." };
  const { label, rule } = outcomeLabel(result.outcome);
  return { tone: "warning", text: `Filtered out: ${label} (${rule}).` };
}

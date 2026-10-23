import type { PlanFix, PlanPreview } from "@ebay-sniper/db";
import type { ProductStatus } from "@ebay-sniper/domain";
import type { ProductFormValues } from "./form.js";

// What src/client/cost-preview.ts reads from the preview URL. The page scripts build under their
// own tsconfig (DOM, no node), so the shape is written out here instead of imported.
export type CostReply = { tone: "info" | "danger"; lines: string[]; meter?: { value: number; max: number } };

// Spec 5.3: the cost box of the form, as text lines, the same for the plain post and for
// cost-preview.ts. A draft is shown with the cost it has once active, since a draft is not polled.

const count = (n: number): string => n.toLocaleString("en-US");
const signed = (n: number): string => `${n < 0 ? "-" : "+"}${count(Math.abs(n))}`;

export function costReply(preview: PlanPreview, product: { status: ProductStatus; values: ProductFormValues }): CostReply {
  if (!preview.ok) return { tone: "danger", lines: ["The cost shows once the fields marked below are fixed."] };
  const { before, after, searchId } = preview;
  const live = product.status === "active" || product.status === "paused";
  const delta = after.total - before.total;
  const where = searchId === null ? `new search for category ${product.values.categoryId} at ${product.values.speed} speed` : `joins search ${searchId}`;
  const first = `${live ? "This product" : "When active"}: ${signed(delta)} calls a day (${where}).`;
  const meter = { value: after.total, max: after.ceiling };
  if (after.ok) {
    return { tone: "info", lines: [first, `Total ${live ? "after save" : "once active"} ${count(after.total)} of ${count(after.ceiling)}, ${count(after.ceiling - after.total)} left.`], meter };
  }
  const total = `Total ${live ? "after save" : "once active"} ${count(after.total)} of ${count(after.ceiling)}: ${count(after.total - after.ceiling)} over the plan.`;
  const fixes = preview.fixes.map((fix) => `${FIX_LABEL[fix.change]} (${signed(fix.delta)})`);
  const fix = fixes.length === 0 ? "No speed fits. Pause or archive another product, or use fewer search words." : `Fits ${fixes.join(" or ")}.`;
  return { tone: "danger", lines: [first, total, fix], meter };
}

// The cheapest change that brings the plan under the ceiling, as the box names it.
const FIX_LABEL: Record<PlanFix["change"], string> = {
  speed_normal: "at normal speed",
  speed_slow: "at slow speed",
  no_price_drop_check: "without the price-drop check",
};

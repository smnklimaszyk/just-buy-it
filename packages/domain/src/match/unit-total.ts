import { foldTitle } from "../classify/fold.js";

// Fixed patterns only; nothing stored by a person ever reaches them.
const MODULES_X_SIZE = /(?<![\p{L}\p{N}])(\d{1,2}) ?x ?(\d{1,3}) ?gb(?!\p{L})/gu;
const KIT_OF = /(?<![\p{L}\p{N}])kit of (\d{1,2})(?!\p{N})/u;
const SIZE = /(?<![\p{L}\p{N}])(\d{1,4}) ?gb(?!\p{L})/gu;

// Section 3.3: the total GB of a per-GB listing. "2x16gb" and "2 x 16 gb" give count x size,
// "kit of 4" with a module size gives 4 x size, else the largest "<n> gb".
export function unitTotalFromTitle(title: string): number | null {
  const text = foldTitle(title).replaceAll("×", "x");
  const modules = [...text.matchAll(MODULES_X_SIZE)].map((m) => Number(m[1]) * Number(m[2]));
  if (modules.length > 0) return Math.max(...modules);
  const sizes = [...text.matchAll(SIZE)].map((m) => Number(m[1]));
  if (sizes.length === 0) return null;
  const kit = KIT_OF.exec(text);
  return kit ? Number(kit[1]) * Math.max(...sizes) : Math.max(...sizes);
}

export type ItemAspect = { name: string; value: string };

const CAPACITY_ASPECTS = ["kapazität", "speicherkapazität", "capacity"];

// After getItem: the total from the capacity item specific, when the title gave none.
export function unitTotalFromAspects(aspects: readonly ItemAspect[]): number | null {
  const values = aspects.filter((a) => CAPACITY_ASPECTS.includes(foldTitle(a.name))).map((a) => a.value);
  return values.length === 0 ? null : unitTotalFromTitle(values.join(" \n "));
}

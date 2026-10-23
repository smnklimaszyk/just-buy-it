// Section 2.1.1. The form shows the groups, the product row stores the eBay condition IDs, and
// market values never mix groups. 7000 (for parts) belongs to no group: it is always defective.
export const CONDITION_GROUPS = ["new", "open_box", "refurbished", "used"] as const;
export type ConditionGroup = (typeof CONDITION_GROUPS)[number];

export const CONDITION_GROUP_IDS: Readonly<Record<ConditionGroup, readonly string[]>> = {
  new: ["1000"],
  open_box: ["1500", "1750"],
  refurbished: ["2000", "2010", "2020", "2030", "2500"],
  used: ["2750", "3000", "4000", "5000", "6000"],
};

export function conditionGroupOf(conditionId: string | null): ConditionGroup | null {
  if (conditionId === null) return null;
  return CONDITION_GROUPS.find((group) => CONDITION_GROUP_IDS[group].includes(conditionId)) ?? null;
}

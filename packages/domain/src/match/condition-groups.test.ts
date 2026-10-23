import { describe, expect, it } from "vitest";
import { conditionGroupOf } from "./condition-groups.js";

describe("conditionGroupOf", () => {
  it.each([
    ["1000", "new"],
    ["1500", "open_box"],
    ["1750", "open_box"],
    ["2000", "refurbished"],
    ["2010", "refurbished"],
    ["2020", "refurbished"],
    ["2030", "refurbished"],
    ["2500", "refurbished"],
    ["2750", "used"],
    ["3000", "used"],
    ["4000", "used"],
    ["5000", "used"],
    ["6000", "used"],
    ["7000", null],
    ["9999", null],
    [null, null],
  ] as const)("%s is %s", (id, group) => {
    expect(conditionGroupOf(id)).toBe(group);
  });
});

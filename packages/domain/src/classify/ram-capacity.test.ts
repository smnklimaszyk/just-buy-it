import { describe, expect, it } from "vitest";
import { foldTitle } from "./fold.js";
import { parseRamCapacityGb } from "./ram-capacity.js";

describe("parseRamCapacityGb", () => {
  it.each([
    ["Corsair Vengeance DDR4 2x16GB 3200", 32],
    ["G.Skill DDR5 2 x 32 GB 6000 CL30", 64],
    ["Kingston Fury DDR4 64GB (2x32GB) 3600", 64],
    ["DDR4 Kit of 4 16GB 3200 MHz", 64],
    ["Crucial DDR5 32GB 5600", 32],
    ["DDR4 16GB 3200 32GB Kit", 32],
    ["DDR5 4x 16GB RGB", 64],
    ["DDR4 2X8GB", 16],
    ["DDR5-6000 CL30 Arbeitsspeicher", null],
    ["DDR4 Kit of 2", null],
  ])("%s gives %s GB", (title, gb) => {
    expect(parseRamCapacityGb(foldTitle(title))).toBe(gb);
  });
});

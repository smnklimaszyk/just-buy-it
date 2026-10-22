import { describe, expect, it } from "vitest";
import { SEGMENTS, segmentInfo } from "./segments.js";

describe("segment table", () => {
  it("gives each segment its feed, sweep minute and labels", () => {
    expect(SEGMENTS.map((s) => [s, segmentInfo(s).feedId, segmentInfo(s).sweepMinute, segmentInfo(s).label])).toEqual([
      ["gpu_3090", "gpu", 5, "RTX 3090"],
      ["gpu_3090ti", "gpu", 15, "RTX 3090 Ti"],
      ["gpu_4090", "gpu", 25, "RTX 4090"],
      ["ram_ddr4", "ram", 35, "DDR4"],
      ["ram_ddr5", "ram", 45, "DDR5"],
      ["pc_4090", "pc", 55, "PC with RTX 4090"],
    ]);
    expect(segmentInfo("gpu_3090").description).toBe("used NVIDIA RTX 3090 graphics card, 24 GB");
  });
});

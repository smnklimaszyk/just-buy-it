import { describe, expect, it } from "vitest";
import { isKnownSegment, SEGMENTS, segmentInfo, segmentLabel } from "./segments.js";

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

// v2 writes product keys such as p_k3x9ab2cde into the same columns; this release reads them.
describe("keys this release does not know", () => {
  it("tells the six segments from any other key", () => {
    expect(SEGMENTS.every(isKnownSegment)).toBe(true);
    expect(isKnownSegment("p_k3x9ab2cde")).toBe(false);
    expect(isKnownSegment("")).toBe(false);
    expect(isKnownSegment("toString")).toBe(false);
  });

  it("labels a known segment by its short name and any other key by the key itself", () => {
    expect(segmentLabel("gpu_3090ti")).toBe("RTX 3090 Ti");
    expect(segmentLabel("p_k3x9ab2cde")).toBe("p_k3x9ab2cde");
    expect(segmentLabel("constructor")).toBe("constructor");
  });
});

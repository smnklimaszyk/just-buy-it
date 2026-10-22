export const FEED_IDS = ["gpu", "ram", "pc"] as const;
export type FeedId = (typeof FEED_IDS)[number];

export const SEGMENTS = ["gpu_3090", "gpu_3090ti", "gpu_4090", "ram_ddr4", "ram_ddr5", "pc_4090"] as const;
export type Segment = (typeof SEGMENTS)[number];

export type SegmentInfo = {
  feedId: FeedId;
  // The minute of the hour in which the segment's sweep may start (section 2.3).
  sweepMinute: number;
  // Short name for email subjects and the dashboard.
  label: string;
  // One line for the Claude request.
  description: string;
};

const INFO: Record<Segment, SegmentInfo> = {
  gpu_3090: {
    feedId: "gpu",
    sweepMinute: 5,
    label: "RTX 3090",
    description: "used NVIDIA RTX 3090 graphics card, 24 GB",
  },
  gpu_3090ti: {
    feedId: "gpu",
    sweepMinute: 15,
    label: "RTX 3090 Ti",
    description: "used NVIDIA RTX 3090 Ti graphics card, 24 GB",
  },
  gpu_4090: {
    feedId: "gpu",
    sweepMinute: 25,
    label: "RTX 4090",
    description: "used NVIDIA RTX 4090 graphics card, 24 GB",
  },
  ram_ddr4: {
    feedId: "ram",
    sweepMinute: 35,
    label: "DDR4",
    description: "used DDR4 desktop RAM (DIMM, non-ECC), at least 32 GB in total",
  },
  ram_ddr5: {
    feedId: "ram",
    sweepMinute: 45,
    label: "DDR5",
    description: "used DDR5 desktop RAM (DIMM, non-ECC), at least 32 GB in total",
  },
  pc_4090: {
    feedId: "pc",
    sweepMinute: 55,
    label: "PC with RTX 4090",
    description: "used gaming desktop PC with an NVIDIA RTX 4090 graphics card",
  },
};

export function segmentInfo(segment: Segment): SegmentInfo {
  return INFO[segment];
}

// Rows v2 wrote may carry a product key such as p_k3x9ab2cde where a segment stood.
export function isKnownSegment(key: string): key is Segment {
  return SEGMENTS.some((segment) => segment === key);
}

// The short name of a known segment, otherwise the key itself.
export function segmentLabel(key: string): string {
  return isKnownSegment(key) ? INFO[key].label : key;
}

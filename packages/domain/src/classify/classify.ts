import type { ListingCandidate } from "../listing.js";
import { checkPriceBand, type SegmentRule } from "../rules.js";
import type { FeedId, Segment } from "../segments.js";
import { foldTitle } from "./fold.js";
import { parseRamCapacityGb } from "./ram-capacity.js";

// Section 4. Reason codes in rule order; the first rule that fires wins.
export const REJECT_REASONS = [
  "not_eur",
  "auction",
  "item_group",
  "no_title",
  "wanted_ad",
  "rental",
  "defective",
  "box_or_picture_only",
  "laptop",
  "accessory",
  "whole_pc_in_gpu_feed",
  "bundle",
  "wrong_model",
  "modded",
  "ram_laptop",
  "ram_server",
  "ram_capacity_unknown",
  "ram_too_small",
  "below_floor",
  "above_max",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

// Kept on the candidate, passed to Claude and shown in the email. Listed in output order.
export const LISTING_FLAGS = [
  "untested",
  "mining_history",
  "custom_cooling",
  "pickup_only",
  "shipping_unknown",
  "financing",
  "open_box_or_refurbished",
  "low_feedback",
  "best_offer",
] as const;
export type ListingFlag = (typeof LISTING_FLAGS)[number];

export type ClassifyResult =
  | { outcome: "candidate"; segment: Segment; flags: ListingFlag[]; totalGb: number | null }
  | { outcome: "rejected"; reason: RejectReason; segment: Segment | null; totalGb: number | null };

// ---- pattern helpers -------------------------------------------------------------------------
// JavaScript's \b is ASCII-only, so word edges are written with Unicode letter and digit classes.

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const re = (source: string, flags = "u") => new RegExp(source, flags);
// The alternatives as whole words.
const word = (alts: string) => re(`${B}(?:${alts})${E}`);
// The alternatives at the start of a word (German compounds and inflections: "defekte", "bastlerware").
const wordStart = (alts: string) => re(`${B}(?:${alts})`);
// Anywhere, also inside a compound ("wasserkühler", "grafikkartenhalterung").
const anywhere = (alts: string) => re(`(?:${alts})`);

const anyOf = (text: string, patterns: readonly RegExp[]) => patterns.some((p) => p.test(text));

// True when some match of the term is not directly preceded by a negation word, and, when
// `after` is given, not ruled out by the rest of its word or the words after it.
function firesUnlessNegated(text: string, term: RegExp, negation: RegExp, after?: RegExp): boolean {
  const global = new RegExp(term.source, "gu");
  for (const match of text.matchAll(global)) {
    if (negation.test(text.slice(0, match.index))) continue;
    if (after?.test(text.slice(match.index + match[0].length))) continue;
    return true;
  }
  return false;
}

// ---- model tokens ----------------------------------------------------------------------------

const M3090 = re("(?<!\\d)3090(?!\\d)", "gu");
const M4090 = re("(?<!\\d)4090(?!\\d)", "gu");
const TI_AFTER_3090 = re("(?<!\\d)3090 ?ti(?![\\p{L}\\p{N}])");
const FIRST_TARGET_MODEL = re("(?<!\\d)(?:3090|4090)(?!\\d)");

const has = (text: string, global: RegExp) => new RegExp(global.source, "u").test(text);

// ---- rules 5 to 8: title and condition fields ------------------------------------------------

const WANTED = word("suche|gesucht|wtb|ankauf|kaufe");
const RENTAL = word("miete|mieten|vermiete|leihe|rent|rental");

const DEFECT_TERMS = wordStart(
  "defekt|kaputt|bastler|for parts|ersatzteil|ohne funktion|funktioniert nicht|not working|broken|no signal|kein bild|artefakte|artifacts|beschädigt|damaged",
);
const DEFECT_NEGATION = re(`${B}(?:nicht|not|kein|keine|keinerlei|ohne|no|never|nie)[^\\p{L}\\p{N}]+$`);
// "defektfrei", "artefaktfrei", and a clause that ends in "keine": "Artefakte keine", "Artefakte:
// keine." A "keine" with a word after it ("Defekt, keine Funktion") is no negation.
const DEFECT_NEGATION_AFTER = re(
  "^(?:[\\p{L}\\p{N}]*frei(?![\\p{L}\\p{N}])|[\\p{L}\\p{N}]*[^\\p{L}\\p{N}]+(?:keine|keiner|keinerlei|none)[^\\p{L}\\p{N}]*(?:$|[.,;!?\\n]))",
);

const BOX_ONLY = [
  re(`${B}nur (?:die )?(?:ovp|verpackung|karton|box)${E}`),
  re(`${B}(?:ovp|box|verpackung|karton) (?:only|ohne inhalt)${E}`),
  re(`${B}leere? (?:ovp|verpackung|karton)${E}`),
  re(`${B}(?:box only|empty box)${E}`),
  re(`${B}nur (?:bild|bilder|foto|fotos)${E}`),
  re(`${B}photo of${E}`),
];

// ---- rules 9 to 14: GPU and PC ----------------------------------------------------------------

const LAPTOP = wordStart("laptop|notebook|max q|mobile gpu");

const ACCESSORY = [
  anywhere("backplate|wasserblock|waterblock|kühlblock|kühler|lüfter|wärmeleitpad|thermal ?pads?|riser|halterung|stütze|anti sag|adapter|kabel|netzteil|gehäuse"),
  word("cooler|fan|bracket|psu|case|cable|shroud"),
];
const ACCESSORY_CONNECTOR = word("für|fuer|for|passend|kompatibel|compatible");
const INCLUSION = word("inkl|inklusive|incl|including|mit|with|plus|samt|nebst|und|&");
const CARD_WORD = [
  anywhere("grafikkarte|graphics card"),
  word("gpu|founders|asus|msi|gigabyte|zotac|palit|gainward|evga|pny|inno3d|kfa2|nvidia"),
  re("(?<!\\d)24 ?gb(?!\\p{L})"),
  re(`${B}gddr6x?${E}`),
];

// Rule 10: an accessory word with a connector ("für") before the model, or an accessory word and no
// card word. An accessory word after the model that follows an inclusion word ("inkl.", "mit")
// is an included extra, not the item.
function isAccessory(text: string): boolean {
  const model = FIRST_TARGET_MODEL.exec(text);
  const modelAt = model ? model.index : Number.POSITIVE_INFINITY;
  const counted: number[] = [];
  for (const pattern of ACCESSORY) {
    for (const match of text.matchAll(new RegExp(pattern.source, "gu"))) {
      const at = match.index;
      const included = at > modelAt && INCLUSION.test(text.slice(modelAt, at));
      if (!included) counted.push(at);
    }
  }
  if (counted.length === 0) return false;
  const connectorBeforeModel = [...text.matchAll(new RegExp(ACCESSORY_CONNECTOR.source, "gu"))].some(
    (m) => m.index < modelAt,
  );
  return connectorBeforeModel || !anyOf(text, CARD_WORD);
}

const SYSTEM_WORD = re(`${B}(?:gaming pc|komplett ?pc|komplettsystem|pc system|rechner|workstation|tower)${E}`, "gu");
const SYSTEM_SOURCE = re(
  `${B}(?:aus|from|für|fuer|for)(?: (?:dem|der|den|einem|einer|meinem|meiner|unserem|my|a|an|the|our))?[^\\p{L}\\p{N}]*$`,
);
const SYSTEM_PART = [
  word("ryzen|intel|threadripper|xeon|ssd|nvme|hdd"),
  re(`${B}core i[3579]${E}`),
  re(`${B}i[3579] ?\\d{4,5}`),
  re(`${B}\\d+ ?gb (?:ram|ddr\\d)${E}`),
];

// Rule 11: a whole system named in the GPU feed, unless the card was taken out of one.
function isWholePc(text: string): boolean {
  const named = [...text.matchAll(SYSTEM_WORD)].some((m) => !SYSTEM_SOURCE.test(text.slice(0, m.index)));
  return named && anyOf(text, SYSTEM_PART);
}

const BUNDLE = [
  re(`${B}(?:[2-9]|\\d{2,}) ?(?:x|×|stück|stk\\.?) (?:nvidia |geforce |rtx ?)*(?:3090|4090)(?!\\d)`),
  re(`${B}(?:konvolut|bundle of|lot of|mining rig)${E}`),
];

const OTHER_GPU_MODEL = [
  re("(?<!\\d)(?:3060|3070|3080|4060|4070|4080|5070|5080|5090)(?!\\d)"),
  word("a6000|titan"),
  re(`${B}rx ?\\d{4}(?!\\d)`),
];
const GPU_4090D = re(`(?<!\\d)4090 ?d${E}`);
const PC_WITHOUT_GPU = re(`${B}(?:ohne (?:grafikkarte|gpu)|without gpu|no gpu)${E}`);
const DDR4 = re(`${B}ddr4(?!\\d)`);
const DDR5 = re(`${B}ddr5(?!\\d)`);

// 48 GB with a 4090 is a VRAM mod (Q5); "48GB RAM" in a PC is system memory.
const MODDED_48GB = re("(?<!\\d)48 ?gb(?! ?(?:ram|ddr|arbeitsspeicher|memory))");
const MODDED = [word("vram mod|bios mod"), wordStart("umgelötet")];

function isModded(text: string): boolean {
  return (has(text, M4090) && MODDED_48GB.test(text)) || anyOf(text, MODDED);
}

// ---- rules 15 to 18: RAM ----------------------------------------------------------------------

const RAM_LAPTOP = wordStart("so ?dimm|sodimm|laptop|notebook");
const RAM_SERVER_STRONG = [
  word("registered|reg|rdimm|lrdimm"),
  re(`(?<![\\p{L}\\p{N}]|un |non )buffered${E}`),
];
const RAM_SERVER_SOFT = word("ecc|server");
// "non ecc", "ohne ecc", "kein ecc", "nicht für server"; DDR5 on-die ECC is not server memory.
const RAM_SERVER_NEGATION = re(
  `(?:${B}(?:non|ohne|nicht|kein|keine|no)(?: (?:für|fuer|for))?|${B}on die)[^\\p{L}\\p{N}]+$`,
);

function isServerRam(text: string): boolean {
  return anyOf(text, RAM_SERVER_STRONG) || firesUnlessNegated(text, RAM_SERVER_SOFT, RAM_SERVER_NEGATION);
}

// ---- flags ------------------------------------------------------------------------------------

const UNTESTED = wordStart("ungetestet|untested|nicht getestet");
const MINING = wordStart("mining|miner");
const CUSTOM_COOLING = anywhere("wasserkühl|wasserblock|waterblock|kühlblock|wakü|water ?cool");
const PICKUP = wordStart("abholung|pickup only");
const FINANCING = [wordStart("finanzierung|ratenkauf"), word("raten")];

function listingFlags(text: string, feedId: FeedId, listing: ListingCandidate): ListingFlag[] {
  const on: Record<ListingFlag, boolean> = {
    untested: UNTESTED.test(text),
    mining_history: MINING.test(text),
    custom_cooling: feedId === "gpu" && CUSTOM_COOLING.test(text),
    pickup_only: PICKUP.test(text),
    shipping_unknown: !listing.shippingKnown,
    financing: anyOf(text, FINANCING),
    open_box_or_refurbished: listing.conditionId === "1500" || listing.conditionId === "2500",
    low_feedback: listing.seller.feedbackScore !== null && listing.seller.feedbackScore < 10,
    best_offer: listing.buyingOptions.includes("BEST_OFFER"),
  };
  return LISTING_FLAGS.filter((f) => on[f]);
}

// ---- segment and the title rules shared with the after-enrich pass ---------------------------

function gpuSegment(text: string): Segment | null {
  if (has(text, M4090)) return "gpu_4090";
  if (has(text, M3090)) return TI_AFTER_3090.test(text) ? "gpu_3090ti" : "gpu_3090";
  return null;
}

// Rules 5 to 8 on the folded title plus the folded condition fields.
function junkReason(junkText: string, conditionId: string | null): RejectReason | null {
  if (WANTED.test(junkText)) return "wanted_ad";
  if (RENTAL.test(junkText)) return "rental";
  if (conditionId === "7000" || firesUnlessNegated(junkText, DEFECT_TERMS, DEFECT_NEGATION, DEFECT_NEGATION_AFTER)) return "defective";
  if (anyOf(junkText, BOX_ONLY)) return "box_or_picture_only";
  return null;
}

// Rule 13 for the feed; returns the segment when the model is right.
function modelCheck(text: string, feedId: FeedId): { segment: Segment } | { reason: "wrong_model" } {
  if (feedId === "gpu") {
    const both = has(text, M3090) && has(text, M4090);
    const segment = gpuSegment(text);
    if (!segment || both || anyOf(text, OTHER_GPU_MODEL) || GPU_4090D.test(text)) return { reason: "wrong_model" };
    return { segment };
  }
  if (feedId === "pc") {
    if (!has(text, M4090) || PC_WITHOUT_GPU.test(text)) return { reason: "wrong_model" };
    return { segment: "pc_4090" };
  }
  const d4 = DDR4.test(text);
  const d5 = DDR5.test(text);
  if (d4 === d5) return { reason: "wrong_model" };
  return { segment: d4 ? "ram_ddr4" : "ram_ddr5" };
}

const rejected = (reason: RejectReason, segment: Segment | null = null, totalGb: number | null = null): ClassifyResult => ({
  outcome: "rejected",
  reason,
  segment,
  totalGb,
});

// The getItem fields the after-enrich pass reads. The item description is not among them: it goes
// to Claude, which judges it in context.
export type EnrichedFields = {
  title: string;
  conditionId: string | null;
  conditionText: string | null;
  conditionDescription: string | null;
  aspects: readonly { name: string; value: string }[];
};

export type AfterEnrichResult = { outcome: "kept"; totalGb: number | null } | { outcome: "rejected"; reason: RejectReason };

function aspectValue(fields: EnrichedFields, name: string): string {
  return fields.aspects
    .filter((a) => foldTitle(a.name) === name)
    .map((a) => foldTitle(a.value))
    .join(" \n ");
}

// Section 4, after enrich: rules 5 to 8, 13 and 14 once more on the getItem title and condition
// fields, and for RAM rules 15 to 17 also on the item specifics Kapazität, Speichertyp and
// Formfaktor. A getItem title of another segment than the candidate's is wrong_model.
export function classifyAfterEnrich(fields: EnrichedFields, feedId: FeedId, segment: Segment): AfterEnrichResult {
  const reject = (reason: RejectReason): AfterEnrichResult => ({ outcome: "rejected", reason });
  const text = foldTitle(fields.title);
  const junkText = [text, foldTitle(fields.conditionText ?? ""), foldTitle(fields.conditionDescription ?? "")].join(" \n ");
  const junk = junkReason(junkText, fields.conditionId);
  if (junk) return reject(junk);
  const model = modelCheck(text, feedId);
  if ("reason" in model || model.segment !== segment) return reject("wrong_model");
  if (feedId !== "ram") return isModded(text) ? reject("modded") : { outcome: "kept", totalGb: null };

  const ramText = [text, aspectValue(fields, "speichertyp"), aspectValue(fields, "formfaktor")].join(" \n ");
  if (RAM_LAPTOP.test(ramText)) return reject("ram_laptop");
  if (isServerRam(ramText)) return reject("ram_server");
  const totalGb = parseRamCapacityGb(text) ?? parseRamCapacityGb(aspectValue(fields, "kapazität"));
  if (totalGb === null) return reject("ram_capacity_unknown");
  return { outcome: "kept", totalGb };
}

// A qualifying listing passed rules 1 to 18: it is the segment's product, whatever its price. Only
// these feed app.price_sample (section 3.5).
export function isQualifyingListing(result: ClassifyResult): boolean {
  return result.outcome === "candidate" || result.reason === "below_floor" || result.reason === "above_max";
}

// Rules 2 to 20 on a summary that toListingCandidate accepted (rule 1, not_eur, is its job).
export function classifyListing(
  listing: ListingCandidate,
  feedId: FeedId,
  rules: Readonly<Record<Segment, SegmentRule>>,
): ClassifyResult {
  if (!listing.buyingOptions.includes("FIXED_PRICE") && !listing.buyingOptions.includes("BEST_OFFER")) {
    return rejected("auction");
  }
  if (listing.itemGroup) return rejected("item_group");
  const text = foldTitle(listing.title);
  if (text === "") return rejected("no_title");

  const junkText = [text, foldTitle(listing.conditionText ?? "")].join(" \n ");
  const junk = junkReason(junkText, listing.conditionId);
  if (junk) return rejected(junk);

  if (feedId !== "ram") {
    if (LAPTOP.test(text)) return rejected("laptop");
  }
  if (feedId === "gpu") {
    if (isAccessory(text)) return rejected("accessory");
    if (isWholePc(text)) return rejected("whole_pc_in_gpu_feed");
    if (anyOf(text, BUNDLE)) return rejected("bundle");
  }
  const model = modelCheck(text, feedId);
  if ("reason" in model) return rejected(model.reason);
  const { segment } = model;
  if (feedId !== "ram" && isModded(text)) return rejected("modded", segment);

  let totalGb: number | null = null;
  const rule = rules[segment];
  if (feedId === "ram") {
    if (RAM_LAPTOP.test(text)) return rejected("ram_laptop", segment);
    if (isServerRam(text)) return rejected("ram_server", segment);
    totalGb = parseRamCapacityGb(text);
    if (totalGb === null) return rejected("ram_capacity_unknown", segment);
    if (rule.kind === "per_gb" && totalGb < rule.minTotalGb) return rejected("ram_too_small", segment, totalGb);
  }

  const band = checkPriceBand(rule, listing, totalGb);
  if (band) return rejected(band, segment, totalGb);
  return { outcome: "candidate", segment, flags: listingFlags(text, feedId, listing), totalGb };
}

import {
  CONDITION_GROUP_IDS,
  CONDITION_GROUPS,
  type ConditionGroup,
  type ProductIssue,
  type ProductRules,
  type ProductStatus,
} from "@ebay-sniper/domain";

// Spec 8.4. The product form posts plain fields (application/x-www-form-urlencoded): word lists
// separated by commas, the must groups one per line, prices in euros. These map them onto the
// fields parseProductRules reads, and stored rules back onto the form.

// What c.req.parseBody({ all: true }) gives for the text fields: repeated names (checkboxes) as
// lists.
export type FormBody = Record<string, string | string[]>;

// The form as the browser posted it, or as the page fills it in.
export type ProductFormValues = {
  name: string;
  description: string;
  searchWords: string;
  mustWords: string;
  excludeWords: string;
  categoryId: string;
  conditionGroups: ConditionGroup[];
  // Advanced: exact eBay condition IDs, used instead of the groups when filled in.
  conditionIds: string;
  priceMode: string;
  maxPrice: string;
  belowMarketPct: string;
  alertRecipientIds: string[];
  speed: string;
  priceDropCheck: boolean;
  floor: string;
  readCeiling: string;
  perGb: boolean;
  unitMinTotal: string;
  unitMaxTotal: string;
  warnWords: string;
  useDefaultJunk: boolean;
  junkExceptions: string[];
  accessoryCheck: boolean;
  candidateCapPerDay: string;
  buyerProfile: string;
  claudeRequired: boolean;
};

const text = (body: FormBody, name: string): string => {
  const value = body[name];
  return typeof value === "string" ? value : (value?.[0] ?? "");
};

const many = (body: FormBody, name: string): string[] => {
  const value = body[name];
  return value === undefined ? [] : typeof value === "string" ? [value] : value;
};

// A checkbox posts its value when it is ticked and nothing when it is not.
const ticked = (body: FormBody, name: string): boolean => many(body, name).length > 0;

export function formValuesFromBody(body: FormBody): ProductFormValues {
  return {
    name: text(body, "name"),
    description: text(body, "description"),
    searchWords: text(body, "searchWords"),
    mustWords: text(body, "mustWords"),
    excludeWords: text(body, "excludeWords"),
    categoryId: text(body, "categoryId"),
    conditionGroups: CONDITION_GROUPS.filter((group) => many(body, "conditionGroups").includes(group)),
    conditionIds: text(body, "conditionIds"),
    priceMode: text(body, "priceMode"),
    maxPrice: text(body, "maxPrice"),
    belowMarketPct: text(body, "belowMarketPct"),
    alertRecipientIds: many(body, "alertRecipientIds"),
    speed: text(body, "speed"),
    priceDropCheck: ticked(body, "priceDropCheck"),
    floor: text(body, "floor"),
    readCeiling: text(body, "readCeiling"),
    perGb: ticked(body, "perGb"),
    unitMinTotal: text(body, "unitMinTotal"),
    unitMaxTotal: text(body, "unitMaxTotal"),
    warnWords: text(body, "warnWords"),
    useDefaultJunk: ticked(body, "useDefaultJunk"),
    junkExceptions: many(body, "junkExceptions"),
    accessoryCheck: ticked(body, "accessoryCheck"),
    candidateCapPerDay: text(body, "candidateCapPerDay"),
    buyerProfile: text(body, "buyerProfile"),
    claudeRequired: ticked(body, "claudeRequired"),
  };
}

// 45000 as "450", 210 as "2.10": what a person would type.
export const eurosInput = (cents: number | null): string =>
  cents === null ? "" : cents % 100 === 0 ? String(cents / 100) : `${String(Math.floor(cents / 100))}.${String(cents % 100).padStart(2, "0")}`;

const numberInput = (value: number | null): string => (value === null ? "" : String(value));

// The groups whose IDs are all chosen. IDs that make up no whole group go to the exact field,
// with the groups they touch ticked.
function conditionValues(ids: readonly string[]): { conditionGroups: ConditionGroup[]; conditionIds: string } {
  const whole = CONDITION_GROUPS.filter((group) => CONDITION_GROUP_IDS[group].every((id) => ids.includes(id)));
  const covered = whole.flatMap((group) => CONDITION_GROUP_IDS[group]);
  if (covered.length === ids.length) return { conditionGroups: whole, conditionIds: "" };
  return {
    conditionGroups: CONDITION_GROUPS.filter((group) => CONDITION_GROUP_IDS[group].some((id) => ids.includes(id))),
    conditionIds: ids.join(", "),
  };
}

export function formValuesFromRules(rules: ProductRules): ProductFormValues {
  return {
    name: rules.name,
    description: rules.description,
    searchWords: rules.searchWords.join(", "),
    mustWords: rules.mustWords.map((group) => group.join(", ")).join("\n"),
    excludeWords: rules.excludeWords.join(", "),
    categoryId: rules.categoryId,
    ...conditionValues(rules.conditionIds),
    priceMode: rules.priceMode,
    maxPrice: eurosInput(rules.maxCents),
    belowMarketPct: numberInput(rules.belowMarketPct),
    alertRecipientIds: rules.alertRecipientIds,
    speed: rules.speed,
    priceDropCheck: rules.priceDropCheck,
    floor: eurosInput(rules.floorCents),
    readCeiling: eurosInput(rules.readCeilingCents),
    perGb: rules.perGb,
    unitMinTotal: numberInput(rules.unitMinTotal),
    unitMaxTotal: numberInput(rules.unitMaxTotal),
    warnWords: rules.warnWords.join(", "),
    useDefaultJunk: rules.useDefaultJunk,
    junkExceptions: rules.junkExceptions,
    accessoryCheck: rules.accessoryCheck,
    candidateCapPerDay: String(rules.candidateCapPerDay),
    buyerProfile: rules.buyerProfile,
    claudeRequired: rules.claudeRequired,
  };
}

// The empty form: the code defaults of spec 2.1, the buyer profile of the settings and the
// person who adds the product as its alert recipient.
export function newFormValues(defaults: { buyerProfile: string; creatorId: string }): ProductFormValues {
  return {
    name: "",
    description: "",
    searchWords: "",
    mustWords: "",
    excludeWords: "",
    categoryId: "",
    conditionGroups: [],
    conditionIds: "",
    priceMode: "fixed",
    maxPrice: "",
    belowMarketPct: "",
    alertRecipientIds: [defaults.creatorId],
    speed: "normal",
    priceDropCheck: false,
    floor: "",
    readCeiling: "",
    perGb: false,
    unitMinTotal: "",
    unitMaxTotal: "",
    warnWords: "",
    useDefaultJunk: true,
    junkExceptions: [],
    accessoryCheck: true,
    candidateCapPerDay: "10",
    buyerProfile: defaults.buyerProfile,
    claudeRequired: false,
  };
}

// "a, b,, c" as ["a", "b", "c"]. Entries are checked and folded by the product parser.
export const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

const splitLines = (value: string): string[][] =>
  value
    .split(/\r?\n/)
    .map(splitList)
    .filter((line) => line.length > 0);

const EUROS = /^(\d{1,8})(?:[.,](\d{1,2}))?$/;
const WHOLE = /^\d{1,9}$/;

const AMOUNT_MESSAGE = "Enter an amount in euros, for example 550 or 2.10.";

export type FieldName = keyof ProductFormValues;

// Messages per form field, and those about the product as a whole.
export type FieldErrors = { byField: Partial<Record<FieldName, string>>; general: string[] };

// The parser's field (spec 2.1) and the form field that carries it.
const FIELD_OF: Record<string, FieldName> = {
  name: "name",
  description: "description",
  searchWords: "searchWords",
  mustWords: "mustWords",
  excludeWords: "excludeWords",
  warnWords: "warnWords",
  categoryId: "categoryId",
  categoryName: "categoryId",
  priceMode: "priceMode",
  maxCents: "maxPrice",
  belowMarketPct: "belowMarketPct",
  floorCents: "floor",
  readCeilingCents: "readCeiling",
  perGb: "perGb",
  unitMinTotal: "unitMinTotal",
  unitMaxTotal: "unitMaxTotal",
  speed: "speed",
  priceDropCheck: "priceDropCheck",
  useDefaultJunk: "useDefaultJunk",
  junkExceptions: "junkExceptions",
  accessoryCheck: "accessoryCheck",
  candidateCapPerDay: "candidateCapPerDay",
  buyerProfile: "buyerProfile",
  claudeRequired: "claudeRequired",
  alertRecipientIds: "alertRecipientIds",
};

const quoted = (entry: string | undefined): string => `“${entry ?? ""}”`;

// Where an issue goes, and its message with the refused entry named: the parser counts list
// positions in the order the form posted them.
function placeIssue(issue: ProductIssue, values: ProductFormValues): { field: FieldName | null; message: string } {
  const [head, at, inner] = issue.path;
  if (head === "conditionIds") {
    const exact = splitList(values.conditionIds);
    if (exact.length === 0) return { field: "conditionGroups", message: issue.message };
    return { field: "conditionIds", message: typeof at === "number" ? `${quoted(exact[at])}: ${issue.message}` : issue.message };
  }
  const field = typeof head === "string" ? (FIELD_OF[head] ?? null) : null;
  if (field === null) return { field: null, message: issue.message };
  if (field === "mustWords" && typeof at === "number") {
    const line = splitLines(values.mustWords)[at];
    const entry = typeof inner === "number" ? `, ${quoted(line?.[inner])}` : "";
    return { field, message: `Line ${String(at + 1)}${entry}: ${issue.message}` };
  }
  if (typeof at === "number" && (field === "searchWords" || field === "excludeWords" || field === "warnWords")) {
    return { field, message: `${quoted(splitList(values[field])[at])}: ${issue.message}` };
  }
  return { field, message: issue.message };
}

export function fieldErrors(issues: readonly ProductIssue[], values: ProductFormValues): FieldErrors {
  const errors: FieldErrors = { byField: {}, general: [] };
  for (const issue of issues) {
    const { field, message } = placeIssue(issue, values);
    if (field === null) errors.general.push(message);
    else errors.byField[field] = errors.byField[field] === undefined ? message : `${errors.byField[field]} ${message}`;
  }
  return errors;
}

// What the parser needs besides the form: the status and category name stay as stored.
export type FormBase = { status: ProductStatus; categoryName: string | null };

export function fieldsFromValues(values: ProductFormValues, base: FormBase): { fields: Record<string, unknown>; issues: ProductIssue[] } {
  const issues: ProductIssue[] = [];
  // Empty means "not given": the parser then names the field or applies its default.
  const euros = (path: string, value: string, empty: null | undefined): number | null | undefined => {
    const trimmed = value.trim();
    if (trimmed === "") return empty;
    const match = EUROS.exec(trimmed);
    if (match === null) {
      issues.push({ path: [path], message: AMOUNT_MESSAGE });
      return undefined;
    }
    return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  };
  const whole = (path: string, value: string, empty: null | undefined): number | null | undefined => {
    const trimmed = value.trim();
    if (trimmed === "") return empty;
    if (!WHOLE.test(trimmed)) {
      issues.push({ path: [path], message: "Enter a whole number." });
      return undefined;
    }
    return Number(trimmed);
  };
  const searchWords = splitList(values.searchWords);
  const mustLines = splitLines(values.mustWords);
  const exact = splitList(values.conditionIds);
  const conditionIds = exact.length > 0 ? exact : values.conditionGroups.flatMap((group) => CONDITION_GROUP_IDS[group]);
  if (conditionIds.length === 0) issues.push({ path: ["conditionIds"], message: "Choose at least one condition." });
  const market = values.priceMode === "below_market";
  const fields: Record<string, unknown> = {
    name: values.name,
    description: values.description,
    status: base.status,
    categoryId: values.categoryId.trim(),
    categoryName: base.categoryName,
    conditionIds,
    searchWords,
    // Spec 8.4: the must field starts as one line of the search words.
    mustWords: mustLines.length > 0 ? mustLines : [searchWords],
    excludeWords: splitList(values.excludeWords),
    warnWords: splitList(values.warnWords),
    useDefaultJunk: values.useDefaultJunk,
    junkExceptions: values.junkExceptions,
    accessoryCheck: values.accessoryCheck,
    perGb: values.perGb,
    unitMinTotal: values.perGb ? whole("unitMinTotal", values.unitMinTotal, undefined) : null,
    unitMaxTotal: values.perGb ? whole("unitMaxTotal", values.unitMaxTotal, null) : null,
    priceMode: values.priceMode,
    maxCents: euros("maxCents", values.maxPrice, undefined),
    belowMarketPct: market ? whole("belowMarketPct", values.belowMarketPct, undefined) : null,
    floorCents: euros("floorCents", values.floor, null),
    readCeilingCents: euros("readCeilingCents", values.readCeiling, null),
    speed: values.speed,
    priceDropCheck: values.priceDropCheck,
    candidateCapPerDay: whole("candidateCapPerDay", values.candidateCapPerDay, undefined),
    buyerProfile: values.buyerProfile === "" ? undefined : values.buyerProfile,
    claudeRequired: values.claudeRequired,
    alertRecipientIds: values.alertRecipientIds,
  };
  return { fields, issues };
}

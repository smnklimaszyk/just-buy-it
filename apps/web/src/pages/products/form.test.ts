import { parseProductRules, type ProductRules } from "@ebay-sniper/domain";
import { describe, expect, it } from "vitest";
import { fieldErrors, fieldsFromValues, formValuesFromBody, formValuesFromRules, type FormBody } from "./form.js";

// The product form (spec 8.4) posts plain form fields. These turn them into the fields the
// product parser reads, and stored rules back into form values.

const BODY: FormBody = {
  name: "Portrait lens",
  description: "Used 85 mm portrait lens for Canon EF. Not a lens hood, not a teleconverter.",
  searchWords: "85mm, portraitobjektiv",
  mustWords: "85mm\ncanon, ef",
  excludeWords: "defekt*, ~kratzer",
  categoryId: "3323",
  conditionGroups: ["used", "open_box"],
  conditionIds: "",
  priceMode: "fixed",
  maxPrice: "450",
  belowMarketPct: "",
  alertRecipientIds: ["0190a3b4-0000-7000-8000-000000000001"],
  speed: "normal",
  floor: "",
  readCeiling: "",
  unitMinTotal: "",
  unitMaxTotal: "",
  warnWords: "",
  useDefaultJunk: "on",
  accessoryCheck: "on",
  candidateCapPerDay: "",
  buyerProfile: "company",
};

const fieldsOf = (body: FormBody) => fieldsFromValues(formValuesFromBody(body), { status: "draft", categoryName: null });

describe("fieldsFromValues", () => {
  it("splits the comma lists and the must lines, maps condition groups to IDs and euros to cents", () => {
    const { fields, issues } = fieldsOf(BODY);

    expect(issues).toEqual([]);
    expect(fields).toEqual({
      name: "Portrait lens",
      description: "Used 85 mm portrait lens for Canon EF. Not a lens hood, not a teleconverter.",
      status: "draft",
      categoryId: "3323",
      categoryName: null,
      conditionIds: ["1500", "1750", "2750", "3000", "4000", "5000", "6000"],
      searchWords: ["85mm", "portraitobjektiv"],
      mustWords: [["85mm"], ["canon", "ef"]],
      excludeWords: ["defekt*", "~kratzer"],
      warnWords: [],
      useDefaultJunk: true,
      junkExceptions: [],
      accessoryCheck: true,
      perGb: false,
      unitMinTotal: null,
      unitMaxTotal: null,
      priceMode: "fixed",
      maxCents: 45_000,
      belowMarketPct: null,
      floorCents: null,
      readCeilingCents: null,
      speed: "normal",
      priceDropCheck: false,
      candidateCapPerDay: undefined,
      buyerProfile: "company",
      claudeRequired: false,
      alertRecipientIds: ["0190a3b4-0000-7000-8000-000000000001"],
    });
    expect(parseProductRules(fields).ok).toBe(true);
  });

  it("reads unticked boxes as off, prefers exact IDs, takes the percent only in market mode, and refuses amounts that are no numbers", () => {
    expect(fieldsOf({ ...BODY, mustWords: " \n " }).fields["mustWords"]).toEqual([["85mm", "portraitobjektiv"]]);
    expect(fieldsOf({ ...BODY, useDefaultJunk: [], accessoryCheck: [], conditionIds: "3000, 4000", priceDropCheck: "on" }).fields).toMatchObject({
      useDefaultJunk: false,
      accessoryCheck: false,
      priceDropCheck: true,
      conditionIds: ["3000", "4000"],
    });
    expect(fieldsOf({ ...BODY, priceMode: "below_market", belowMarketPct: "15", unitMinTotal: "32" }).fields).toMatchObject({
      belowMarketPct: 15,
      unitMinTotal: null,
    });
    expect(fieldsOf({ ...BODY, belowMarketPct: "15", maxPrice: "2,10", perGb: "on", unitMinTotal: "32" }).fields).toMatchObject({
      belowMarketPct: null,
      maxCents: 210,
      unitMinTotal: 32,
      unitMaxTotal: null,
    });
    expect(fieldsOf({ ...BODY, maxPrice: "4.50.0", floor: "-3", candidateCapPerDay: "ten", conditionGroups: [] }).issues).toEqual([
      { path: ["conditionIds"], message: "Choose at least one condition." },
      { path: ["maxCents"], message: "Enter an amount in euros, for example 550 or 2.10." },
      { path: ["floorCents"], message: "Enter an amount in euros, for example 550 or 2.10." },
      { path: ["candidateCapPerDay"], message: "Enter a whole number." },
    ]);
  });
});

describe("formValuesFromRules", () => {
  const rules = (fields: unknown): ProductRules => {
    const parsed = parseProductRules(fields);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.value;
  };

  it("gives back the same rules when the stored values are posted again, and lists IDs that are not a whole group", () => {
    const stored = rules({
      ...fieldsOf(BODY).fields,
      priceMode: "below_market",
      belowMarketPct: 15,
      floorCents: 20_000,
      readCeilingCents: 90_000,
      warnWords: ["gebraucht"],
      junkExceptions: ["rental"],
      candidateCapPerDay: 20,
      speed: "slow",
      claudeRequired: true,
    });
    const values = formValuesFromRules(stored);
    const body: FormBody = Object.fromEntries(
      Object.entries(values).flatMap(([key, value]) => (value === false ? [] : [[key, value === true ? "on" : value]])),
    );

    expect(values.conditionGroups).toEqual(["open_box", "used"]);
    expect(values.conditionIds).toBe("");
    expect(values.mustWords).toBe("85mm\ncanon, ef");
    expect(rules(fieldsFromValues(formValuesFromBody(body), { status: stored.status, categoryName: null }).fields)).toEqual(stored);

    const partial = formValuesFromRules(rules({ ...fieldsOf(BODY).fields, conditionIds: ["3000", "1000"] }));
    expect(partial.conditionGroups).toEqual(["new", "used"]);
    expect(partial.conditionIds).toBe("3000, 1000");
  });
});

describe("fieldErrors", () => {
  it("puts each issue on its form field, names the entry that was refused and keeps product-wide issues apart", () => {
    const values = formValuesFromBody({ ...BODY, excludeWords: "ok, (a+)+$", mustWords: "85mm\ncanon, .*" });
    const errors = fieldErrors(
      [
        { path: ["excludeWords", 1], message: "Use letters and digits." },
        { path: ["mustWords", 1, 1], message: "Use letters and digits." },
        { path: ["maxCents"], message: "Enter a price above 0." },
        { path: ["categoryName"], message: "Use at most 200 characters." },
        { path: ["conditionIds"], message: "Choose at least one condition." },
        { path: [], message: "The product is too long for the Claude check." },
      ],
      values,
    );

    expect(errors.byField).toEqual({
      excludeWords: "“(a+)+$”: Use letters and digits.",
      mustWords: "Line 2, “.*”: Use letters and digits.",
      maxPrice: "Enter a price above 0.",
      categoryId: "Use at most 200 characters.",
      conditionGroups: "Choose at least one condition.",
    });
    expect(errors.general).toEqual(["The product is too long for the Claude check."]);
    expect(fieldErrors([{ path: ["conditionIds", 0], message: "Choose an eBay condition ID." }], formValuesFromBody({ ...BODY, conditionIds: "9999" })).byField).toEqual({
      conditionIds: "“9999”: Choose an eBay condition ID.",
    });
  });
});

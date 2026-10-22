import { describe, expect, it } from "vitest";
import { vatLine } from "./vat.js";

const base = { profile: "company" as const, sellerAccountType: "business" as const, title: "RTX 4090 Gaming OC", description: "", grossCents: 128000 };

describe("vatLine", () => {
  it.each([
    ["business seller with mwst. ausweisbar", { description: "MwSt. ausweisbar, Rechnung liegt bei" }, "Business seller states a VAT invoice. If you get one, the net price is about EUR 1,075.63."],
    ["business seller with Rechnung mit ausgewiesener MwSt", { description: "Rechnung mit ausgewiesener MwSt." }, "Business seller states a VAT invoice. If you get one, the net price is about EUR 1,075.63."],
    ["business seller with inkl. 19 % MwSt in the title", { title: "RTX 4090 inkl. 19% MwSt", grossCents: 48900 }, "Business seller states a VAT invoice. If you get one, the net price is about EUR 410.92."],
    ["business seller with VAT invoice", { description: "VAT invoice available" }, "Business seller states a VAT invoice. If you get one, the net price is about EUR 1,075.63."],
    ["business seller without a phrase", {}, "Business seller. Ask for an invoice with VAT shown before buying."],
    ["private seller", { sellerAccountType: "private" as const, description: "MwSt. ausweisbar" }, "Private seller: no VAT invoice, no input-tax deduction."],
    ["unknown seller type", { sellerAccountType: null }, "Seller type unknown. Ask for an invoice with VAT shown before buying."],
    ["the private buyer profile", { profile: "private" as const, description: "MwSt. ausweisbar" }, "Private purchase: compared at gross."],
  ])("%s", (_name, extra, line) => {
    expect(vatLine({ ...base, ...extra })).toBe(line);
  });
});

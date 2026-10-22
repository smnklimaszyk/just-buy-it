import { foldTitle } from "./classify/fold.js";
import type { SellerAccountType } from "./listing.js";
import { formatEur } from "./money.js";

export type BuyerProfile = "company" | "private";

// The only place the description is searched by a substring rule; it changes this line only,
// never a rejection (section 3.3).
const VAT_PHRASE = /mwst\.? ausweisbar|rechnung mit ausgewiesener mwst|inkl\.? 19 ?% mwst|vat invoice/u;
const VAT_RATE_PERCENT = 19;

export type VatLineInput = {
  profile: BuyerProfile;
  sellerAccountType: SellerAccountType | null;
  title: string;
  description: string;
  // Landed price, or the item price while shipping is unknown.
  grossCents: number;
};

// The VAT line of the alert email. The comparison is gross in both profiles (inputTaxDeductible
// is false); the profile changes this line only (D-04).
export function vatLine(input: VatLineInput): string {
  if (input.profile === "private") return "Private purchase: compared at gross.";
  if (input.sellerAccountType === "private") return "Private seller: no VAT invoice, no input-tax deduction.";
  if (input.sellerAccountType === null) return "Seller type unknown. Ask for an invoice with VAT shown before buying.";
  const text = `${foldTitle(input.title)} \n ${foldTitle(input.description)}`;
  if (!VAT_PHRASE.test(text)) return "Business seller. Ask for an invoice with VAT shown before buying.";
  const net = Math.round((input.grossCents * 100) / (100 + VAT_RATE_PERCENT));
  return `Business seller states a VAT invoice. If you get one, the net price is about ${formatEur(net)}.`;
}

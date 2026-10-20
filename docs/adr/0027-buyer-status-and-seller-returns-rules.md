# ADR-0027: Buyer profile and seller-returns rules

**Date**: 2026-10-19
**Status**: proposed
**Related**: ADR 0020; D-01, D-04, D-05/D-06; [company vs private](../planning/guides/company-vs-private.md)

## Context

- The plan's 5% premium for private sellers without returns assumes consumer rights; its default buyer, the company, has none.
- D-04: Intra AI buys through its business eBay account (required by [eBay-AGB § 2 Abs. 4](https://www.ebay.de/help/policies/member-behaviour-policies/nutzungsbedingungen?id=4259)); Simon can check a listing as a private purchase (private account, private use).
- Consumer: 14-day withdrawal against an Unternehmer (§§ 312g, 355 BGB); [§ 476 BGB](https://www.gesetze-im-internet.de/bgb/__476.html) blocks blanket warranty exclusions. A company has neither. Unverified: § 307 BGB for a business seller's standard-terms exclusion; the § 312g Abs. 2 Nr. 10 auction exception (current wording); BGH described-condition rulings (VIII ZR 92/06, 161/23) predate the 2022 § 434 reform, so applying them is a reading.
- Käuferschutz deadlines: 30 days after the shown delivery date for returns and non-receipt, 30 days to escalate; coverage of company buyers is a reading, not confirmed by eBay.
- Input tax needs a VAT invoice from a standard-taxed seller (§ 15 UStG); margin-scheme, § 19 and private sellers issue none. If Intra AI uses § 19 itself, deduction is probably excluded; `inputTaxDeductible` is `false` until Simon confirms. Legal form is not recorded; § 377 HGB applies only if both parties are Kaufleute.
- Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.

## Decision

`watch.buyer_profile` (`company` | `private`, not null, default `company`) replaces `buyer_status`, is copied to each decision row and selects the rules below from config `buyerProfiles` (ADR 0009). One profile per watch and alert.

| Rule | `company` | `private` |
|---|---|---|
| Account line | Intra AI business account | Simon's private account |
| Business seller, no returns | Medium (provisional) | High above EUR 500 landed, else Medium |
| Private seller, no returns | Medium (provisional) | No signal |
| Risk premium | 5%, any seller without returns | 5%, private sellers without returns |
| Compared with watch max | Net if `vat_invoice_stated` and `inputTaxDeductible`, else gross | Gross landed |
| Tier (ADR 0017) | Gross landed × (1 + premium) | Same |
| VAT flags | All | Only `price_may_exclude_vat` |
| Checklist (ADR 0022) | No withdrawal; conditional § 377 HGB line; Käuferschutz deadlines; confirm VAT invoice | Business seller: 14-day withdrawal ("probably" for auctions); private seller: warranty often excluded, description may count; deadlines |

- VAT class, first match wins: `no_vat_private_seller`, `no_vat_margin_scheme`, `no_vat_small_business`, `foreign_seller`, `vat_invoice_stated`, `unknown`; text-only booleans `vat_invoice_phrase`, `price_may_exclude_vat`. Net: `round(landed_cents × 10000 / (10000 + standardRateBp))`. Band check and bid limit (ADR 0032) compare `basis_cents × (1 + premium)`. VAT never changes tier or verdict; net alerts say the invoice statement is unverified.
- Flags `no_vat_invoice`, `vat_invoice_text`, `foreign_seller_vat`, `price_may_exclude_vat`, `vat_invoice_unconfirmed`, `vat_invoice_stated`, `in_band_only_at_net` label, never score.
- Watch form label "Max price for the company, gross" until net is on; edits apply to new decisions only. Alert header shows the profile and links to the dashboard check.
- What-if under the other profile: pure functions on stored inputs, no eBay or Claude call, no writes or alerts, labelled "what-if, not stored", disabled once the listing row is gone (tested: no row, no job).
- Values change only via a new config version; decision rows store config version, `buyer_profile`, `vat_class`, `price_basis`, `basis_cents`. 5% and EUR 500 are plan values, calibrated in Phase 5 (ADR 0033).
- Simon reviews all legal wording before it ships (D-01): a reading of the sources, not legal or tax advice; money-relevant points (input tax, warranty disputes) go to a tax adviser or lawyer.

## Alternatives considered

Plan as is (premium measures rights the company lacks); one global status (no private check); per-recipient verdicts (Simon is the only buyer); both results per alert (invites buying privately for the company); no returns rules (missing returns is a real risk for used hardware).

## Consequences

- **Positive**: one config table; legal or tax answers become config changes with a backtest.
- **Negative**: double rubric tests; extra columns, five pure functions, two checklists, one button.
- **Risks**: unverified readings are wrong (mitigation: "probably" wording, provisional values, review); "MwSt. ausweisbar" seller text lowers the company price about 16% (German business sellers, band and bid only, labelled unverified).

## How we check it

- Golden tests: per profile, business/private seller, with/without returns, EUR 499/500/501 landed; `vatClass()` per class and precedence; `priceBasis()` rounding at EUR 499.99 and 500.00.
- Tier tests: premium hits only the right sellers per profile; input is gross.
- Band test: a company alert at net carries `vat_invoice_stated`, plus `in_band_only_at_net` when gross exceeds the maximum.
- Property tests: VAT class never changes the verdict; profile never changes the tier input.
- Email snapshots per profile: withdrawal line only with `private`; no email shows both results.
- Schema tests: `buyer_profile` valid on watches; decision rows carry `buyer_profile`, `price_basis`, config version; config has both profiles.

## Revisit when

- Simon records input-tax status (including § 19 use) or legal form, or § 307 BGB is checked.
- A legal reading is corrected, or a § 312g Abs. 2 Nr. 10 or § 434 ruling appears.
- eBay changes the API Licence Agreement.
- Colleagues start buying, or one watch needs both profiles.

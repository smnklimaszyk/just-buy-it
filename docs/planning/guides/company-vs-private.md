# Company vs private buying (D-04)

As of 2026-10-19. Owner and compliance owner: Simon Klimaszyk (D-01). Not legal or tax advice; Simon checks money points with a tax adviser or lawyer. Decisions: [../02-decisions.md](../02-decisions.md). ADRs 0009, 0017, 0020, 0022, 0027, 0032 in [../../adr/README.md](../../adr/README.md).

## Result

- One field `buyer_profile` (`company` | `private`) per watch, default `company`, copied to every decision row. Replaces `buyer_status` in ADR 0009 and 0027.
- One profile per alert. The dashboard can recompute a listing under the other profile as a what-if: never stored, never alerts.
- Company purchases use the Intra AI business eBay account; private purchases use Simon's private account, for private use only. The system never logs into either account; a person buys in eBay checkout (ADR 0002, gate 3).
- A seller's VAT statement never changes the risk verdict.
- **Seller type is not gated.** Every seller-type output in this guide is on. Anyone running this tool is responsible for complying with the eBay API License Agreement and eBay's policies for their use.
- The household exemption (ADR 0018) does not apply, because Intra AI runs the system. The private check does not change that.

## Legal differences that change the rules

| Topic | Rule | Effect on the tool |
|---|---|---|
| Consumer vs business | Consumer: natural person, purpose mainly private (§ 13 BGB); Unternehmer acts in trade or profession (§ 14) | Company hardware is a company purchase whoever clicks "buy" |
| eBay account | eBay-AGB § 2 Abs. 4: anyone using eBay for business needs a business account ([AGB](https://www.ebay.de/help/policies/member-behaviour-policies/nutzungsbedingungen?id=4259)) | Each checklist names the account to buy with |
| Withdrawal | 14 days for a consumer against an Unternehmer (§§ 312g, 355 BGB). None for a company, none against a private seller. Auctions: BGH VIII ZR 375/03 (2004, old wording) kept the right; current wording **unverified** | Only the private checklist shows it; for auctions it says "probably" |
| Warranty, business seller | To a consumer: no blanket exclusion; specific agreed deviations and one year for used goods allowed ([§ 476](https://www.gesetze-im-internet.de/bgb/__476.html)); one-year presumption (§ 477). To a company: exclusion probably possible; **§ 307 BGB not checked** | The company returns rules are provisional |
| Warranty, private seller | Can be excluded, except fraud or guarantee (§ 444). A described condition ("getestet, voll funktionsfähig") probably still counts (BGH VIII ZR 92/06, VIII ZR 161/23, pre-2022 law) | The private checklist says "may still count" |
| Inspection duty | [§ 377 HGB](https://www.gesetze-im-internet.de/hgb/__377.html) if both sides are Kaufleute (GmbH/UG by form; sole trader only if registered or commercially organised) | Conditional line in the company checklist |
| Käuferschutz | [Policy](https://www.ebay.de/help/policies/ebay-money-back-guarantee-policy/grundsatz-zum-ebaykuferschutz?id=4210) names no exclusion for business buyers (reading, unconfirmed). Return: 30 days after delivery (or longer seller window). Not received: 30 days after the shown delivery date. Escalate within 30 days or it closes | Deadlines in both checklists |
| Input tax | Deductible with a proper invoice from an Unternehmer ([§ 15 UStG](https://www.gesetze-im-internet.de/ustg_1980/__15.html)), 19%. None from private sellers, margin scheme ([§ 25a](https://www.gesetze-im-internet.de/ustg_1980/__25a.html)) or small businesses ([§ 19](https://www.gesetze-im-internet.de/ustg_1980/__19.html)). Under § 19 itself, Intra AI probably cannot deduct | Basis of the company net price |

"MwSt. ausweisbar" is seller text, not an eBay field. getItem `taxes[]` is unmeasured; the Phase 0 harness records it for 20 business-seller items before any rule uses it. `sellerLegalInfo` is not read.

## What the profile changes

| Item | `company` (default) | `private` |
|---|---|---|
| Risk premium (tier, band, bid limit) | 5% for any seller without returns | 5% for private sellers without returns |
| Seller-returns rules (ADR 0027) | Any seller, no returns: Medium (provisional until § 307 is checked) | Business seller, no returns: High above EUR 500 landed, else Medium. Private seller: no signal |
| Price vs watch maximum | Net if `vat_invoice_stated` and `inputTaxDeductible`, else gross | Gross landed |

The tier is gross landed × (1 + premium) for both profiles. It stays gross because the snapshot is a median of gross asks (a net price would look about 16% cheaper); net only decides the company's own band and bid. 5% and EUR 500 are config starting values, reviewed in Phase 5 (ADR 0033).

## VAT class (deterministic scan, first match wins)

| Class | Rule |
|---|---|
| `no_vat_private_seller` | `sellerAccountType` = `INDIVIDUAL` |
| `no_vat_margin_scheme` | "differenzbesteuert", "Differenzbesteuerung", "§ 25a", "Gebrauchtgegenstände/Sonderregelung", "MwSt. nicht ausweisbar", "keine MwSt. ausweisbar" |
| `no_vat_small_business` | "§ 19 UStG", "Kleinunternehmer" |
| `foreign_seller` | Item location not DE |
| `vat_invoice_stated` | `BUSINESS` seller and an invoice phrase: "MwSt. ausweisbar", "Rechnung mit ausgewiesener MwSt", "... Mehrwertsteuer", "USt. ausweisbar" |
| `unknown` | Everything else |

Lists live in `vatPhrases.v1.ts`. "zzgl. MwSt." / "Nettopreis" set `price_may_exclude_vat`.

## Company price basis and bid limit

- `basis_cents = round(landed × 10000 / (10000 + 1900))` when class is `vat_invoice_stated` and `inputTaxDeductible` is true; otherwise `landed_cents`. Shipping included.
- Band check and bid limit pass when `basis × (10000 + premiumBp) ≤ max × 10000`.
- `effectiveMaxBid`: `floor(max × (10000 + rate) / (10000 + premium))` (net) or `floor(max × 10000 / (10000 + premium))` (gross), minus shipping, then step by cents to the largest bid passing the band check. The bid is always gross.

Golden cases (max EUR 500.00, shipping EUR 6.99, 19%):

| Basis | Premium | Bid limit |
|---|---|---|
| Net | 5% | EUR 559.68 (formula: 559.67; old formula: 588.01) |
| Net | 0% | EUR 588.01 |
| Gross | 5% | EUR 469.20 |
| Gross | 0% | EUR 493.01 |

A seller's VAT statement counts only from a German `BUSINESS` account and changes band and bid only. Alert text: "compared at net EUR X, VAT invoice stated by seller (not verified)"; the checklist says to confirm the invoice in eBay messages.

## Flags and checklists

Company flags (labels, no score): `no_vat_invoice`, `vat_invoice_unconfirmed` (business seller, `unknown`), `vat_invoice_stated`, `in_band_only_at_net`, `foreign_seller_vat`. Both: `price_may_exclude_vat`.

Company checklist: business account, no withdrawal, § 377 line if both are Kaufleute, Käuferschutz deadlines, keep the invoice. Private: private account, seller-type line (business: 14-day withdrawal; private: none, described condition may count), Käuferschutz deadlines. Simon approves the wording.

## Alerts, data, code

- The email header shows the profile; the email has one result, its flags, checklist and a what-if link. Two results per email was rejected: double work, invites private buying for company use.
- The watch form label for the maximum says what is compared: company, net after input tax (gross while `inputTaxDeductible` is false); private, what you pay. A profile edit applies to new decisions only.
- Alert key (ADR 0015) and auction index unchanged. If both profiles match a listing, the alert uses `company` (owner to confirm).
- What-if uses stored inputs only: no eBay or Claude call, no write; disabled once the listing row is purged (ADR 0014).
- Schema: `watch.buyer_profile` not null default `company`; listing `vat_class`, `vat_invoice_phrase`, `price_may_exclude_vat`, `seller_account_type`; decision `buyer_profile`, `vat_class`, `price_basis`, `basis_cents` (retention: `basis_cents` 30 days, the rest 180).
- Config `decision.v1.ts` `buyerProfiles` (`standardRateBp: 1900`, `inputTaxDeductible: false`); pure functions in `packages/domain/src/decide/buyerProfile.ts`.
- Tests: VAT class goldens; bid rows pass at the limit, fail one cent above; VAT class never changes the verdict; what-if writes nothing.

## Owner to confirm (Phase 0 owner checklist)

| Point | Until confirmed |
|---|---|
| Intra AI can deduct input tax (standard taxation, not § 19 UStG) | `inputTaxDeductible: false`, company compares gross. Switching is one config version |
| Intra AI's legal form (GmbH/UG, registered sole trader, unregistered) | § 377 HGB line stays conditional |
| Intra AI business eBay.de account opened | No company purchase |

Open, no action now: § 307 BGB (company Medium provisional), auction withdrawal under current wording, Käuferschutz for business buyers, EU and B2B VAT-ID sales (`foreign_seller`, gross). Hardware bought privately and later moved into the company loses input tax, and consumer rights stay with Simon; he checks this with the tax adviser. Not modelled.

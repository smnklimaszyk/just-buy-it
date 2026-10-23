import type { Person, StoredProduct } from "@ebay-sniper/db";
import { formatBerlinTime, CONDITION_GROUP_IDS, CONDITION_GROUPS, DEFAULT_JUNK_RULES, MAX_QUERY_CHARS, PLANNED_CALLS_CEILING, searchQuery } from "@ebay-sniper/domain";
import type { ClientScript } from "../../ui/assets.js";
import { Button, Icon, Link } from "../../ui/core.js";
import { Banner, Callout, Meter } from "../../ui/feedback.js";
import type { CostReply } from "./cost.js";
import type { CategoryRequest } from "./queries.js";
import type { TitleCheck } from "./title-check.js";
import { Checkbox, Fieldset, Input, RadioGroup, TagsInput, Textarea } from "../../ui/forms.js";
import { PageHeader } from "../../ui/navigation.js";
import { formValuesFromRules, splitList, type FieldErrors, type FieldName, type ProductFormValues } from "./form.js";
import { GROUP_LABEL } from "./list-view.js";
import { MarketSummary, type MarketData } from "./market-view.js";

// Spec 8.4: one page with Fieldsets.

// The page scripts of the form: chips for the word lists, the live cost box, the busy button.
export const FORM_SCRIPTS: ClientScript[] = ["tags", "cost-preview", "form-busy"];

export type ProductFormProps = {
  // null for a new product.
  product: StoredProduct | null;
  values: ProductFormValues;
  errors: FieldErrors;
  people: Person[];
  alertTo: string;
  csrf: string;
  // The cost box after "Check cost" or a refused save; null shows how to get it.
  cost: CostReply | null;
  // The daily plan of the stored products, where the Meter starts before "Check cost".
  planTotal: number;
  // A stored product's market values (spec 6.5); null for a new product.
  market: (Pick<MarketData, "values" | "ok"> & { now: Date }) | null;
  // The categories of the stored products, as quick picks next to the field (spec 8.4 item 5).
  categoriesInUse: { categoryId: string; categoryName: string | null }[];
  // A save on an older version (spec 5.3); `product` is then the stored one.
  conflict: Conflict | null;
  // The category suggestion asked for with this form, if any.
  categories: CategoryRequest | null;
  // The result of "Test title" with the title that was tested.
  titleCheck: (TitleCheck & { title: string }) | null;
};

export type Conflict = { changedBy: string; changedAt: Date };

export const fieldId = (name: FieldName): string => `product-${name}`;

// Spec 5.2: polls a day per search at each speed.
const SPEEDS = [
  { value: "fast", label: "Fast", description: "Every 2 minutes by day, 10 at night: 528 polls a day" },
  { value: "normal", label: "Normal", description: "Every 5 minutes by day, 10 at night: 240 polls a day" },
  { value: "slow", label: "Slow", description: "Every 15 minutes by day, 30 at night: 80 polls a day" },
];

const JUNK_REASON: Record<string, string> = {
  wanted_ad: "Wanted ads",
  rental: "Rentals",
  defective: "Defective or for parts",
  box_or_picture_only: "Box or picture only",
  bundle: "Bundles",
};

const queryLeft = (words: string): string => {
  const list = splitList(words);
  const used = list.length === 0 ? 0 : searchQuery(list).length;
  return `${String(Math.max(0, MAX_QUERY_CHARS - used))} of ${String(MAX_QUERY_CHARS)} characters of the eBay query left.`;
};

// The label of each field that can carry an error, for the links of the summary.
export function fieldLabel(name: FieldName, values: ProductFormValues): string {
  const labels: Partial<Record<FieldName, string>> = {
    name: "Name",
    description: "Description for the Claude check",
    searchWords: "Search words",
    mustWords: "Must contain",
    excludeWords: "Must not contain",
    categoryId: "eBay category",
    conditionGroups: "Condition",
    priceMode: "Price rule",
    maxPrice: values.priceMode === "below_market" ? "Never above (EUR)" : "Max price (EUR)",
    belowMarketPct: "Percent below",
    alertRecipientIds: "Email alerts to",
    speed: "Speed",
    floor: "Floor (EUR)",
    readCeiling: "Poll price ceiling (EUR)",
    unitMinTotal: "Minimum total size (GB)",
    unitMaxTotal: "Largest kit the price-drop check reads (GB)",
    warnWords: "Warning words",
    junkExceptions: "Junk rules this product turns off",
    candidateCapPerDay: "Candidates per day",
    buyerProfile: "Buyer profile",
    conditionIds: "Exact condition IDs",
  };
  return labels[name] ?? name;
}

// Spec 8.4: "2 fields need attention" with a link to each, and what is wrong with the product as a whole.
function ErrorSummary({ errors, values }: { errors: FieldErrors; values: ProductFormValues }) {
  const fields = Object.keys(errors.byField) as FieldName[];
  if (fields.length === 0 && errors.general.length === 0) return null;
  const title = fields.length === 1 ? "1 field needs attention" : fields.length > 1 ? `${String(fields.length)} fields need attention` : "The product could not be saved";
  return (
    <Callout tone="danger" title={title}>
      <ul>
        {fields.map((name) => (
          <li>
            <Link href={`#${fieldId(name)}`}>{fieldLabel(name, values)}</Link>
          </li>
        ))}
        {errors.general.map((message) => (
          <li>{message}</li>
        ))}
      </ul>
    </Callout>
  );
}

// Spec 8.4 item 9: the preview lines of 5.3 in an info Callout, danger when over, and a Meter of
// the plan after the save. cost-preview.ts replaces the lines and the Meter in place.
function CostBox({ cost, planTotal }: { cost: CostReply | null; planTotal: number }) {
  return (
    <div data-cost-result="">
      <Callout tone={cost?.tone ?? "info"} title="Cost">
        {(cost?.lines ?? ["Check cost shows what this product adds to the daily plan of eBay calls."]).map((line) => (
          <p>{line}</p>
        ))}
      </Callout>
      <Meter value={cost?.meter?.value ?? planTotal} max={cost?.meter?.max ?? PLANNED_CALLS_CEILING} label="Daily plan after save" />
    </div>
  );
}

// Spec 8.4: "Simon changed this product at 14:05. Your changes were not saved." with both values
// of every field that differs from what is stored now.
function ConflictBanner({ product, values, conflict }: { product: StoredProduct; values: ProductFormValues; conflict: Conflict }) {
  const stored = formValuesFromRules(product.rules);
  const shown = (value: ProductFormValues[FieldName]): string => (Array.isArray(value) ? value.join(", ") : String(value));
  const differences = (Object.keys(stored) as FieldName[]).filter((name) => shown(stored[name]) !== shown(values[name]));
  return (
    <Banner tone="warning">
      {`${conflict.changedBy} changed this product at ${formatBerlinTime(conflict.changedAt)}. Your changes were not saved.`}
      <ul>
        {differences.map((name) => (
          <li>
            {fieldLabel(name, values)}: yours {shown(values[name]) || "empty"}, now {shown(stored[name]) || "empty"}
          </li>
        ))}
      </ul>
      Save again to keep yours.
    </Banner>
  );
}

// Spec 6.6 "Suggest category" (secondary): the worker searches eBay for the search words; the
// request's id goes back with the form, so the next press shows what it found.
function CategoryHelp({ categories }: { categories: CategoryRequest | null }) {
  const pending = categories !== null && categories.status !== "done" && categories.status !== "refused";
  return (
    <div class="app-stack">
      {categories !== null && <input type="hidden" name="categoryRequest" value={categories.id} />}
      {pending && <p class="type-ui-body-sm">Looking for categories. Press Show suggestions in a few seconds.</p>}
      {categories !== null && categories.suggestions.length > 0 && (
        <RadioGroup
          legend="Suggested categories"
          name="categoryPick"
          value=""
          options={[
            { value: "", label: "Keep the ID typed above" },
            ...categories.suggestions.map((s) => ({
              value: s.categoryId,
              label: `${s.categoryName ?? "Unnamed category"} (${s.categoryId})`,
              description: `${s.matchCount.toLocaleString("en-US")} matches`,
            })),
          ]}
        />
      )}
      <div class="app-row">
        <Button type="submit" name="intent" value="suggest">
          {pending ? "Show suggestions" : "Suggest category"}
        </Button>
      </div>
    </div>
  );
}

export function ProductForm({
  product,
  values,
  errors,
  people,
  alertTo,
  csrf,
  cost,
  planTotal,
  market,
  categoriesInUse,
  conflict,
  categories,
  titleCheck,
}: ProductFormProps) {
  const error = (name: FieldName) => errors.byField[name];
  const action = product === null ? "/products/new" : `/products/${product.key}/edit`;
  return (
    <>
      <PageHeader title={product === null ? "Add product" : `Edit ${product.rules.name}`} />
      <form method="post" action={action} class="app-columns" data-cost-preview={`${action}/cost`}>
        <input type="hidden" name="_csrf" value={csrf} />
        {/* Spec 5.3: the version the form loaded; a save on an older one is refused. */}
        {product !== null && <input type="hidden" name="version" value={String(product.version)} />}
        <div class="app-stack">
        {product !== null && conflict !== null && <ConflictBanner product={product} values={values} conflict={conflict} />}
        <ErrorSummary errors={errors} values={values} />
        <Fieldset legend="What you are looking for">
          <Input id={fieldId("name")} name="name" label="Name" value={values.name} maxlength={60} error={error("name")} />
          <Textarea
            id={fieldId("description")}
            name="description"
            label="Description for the Claude check"
            hint="Say what it is and what it is not, for example 'Used road bike, 56 cm frame, carbon. Not a frame set, not an e-bike.'"
            maxLength={300}
            value={values.description}
            error={error("description")}
          />
          <TagsInput
            id={fieldId("searchWords")}
            name="searchWords"
            label="Search words"
            hint={`One word each, separated by commas. ${queryLeft(values.searchWords)}`}
            value={splitList(values.searchWords)}
            max={8}
            error={error("searchWords")}
          />
          <Textarea
            id={fieldId("mustWords")}
            name="mustWords"
            label="Must contain"
            hint="One group per line; every line must match. Inside a line, alternatives separated by commas. Left empty: one line with your search words."
            value={values.mustWords}
            error={error("mustWords")}
          />
          <TagsInput
            id={fieldId("excludeWords")}
            name="excludeWords"
            label="Must not contain"
            hint="Separated by commas. word* matches words that start with it, two words match in a row, ~word does not count after nicht, kein or ohne. No other symbols are accepted. Text inside a longer word does not match."
            value={splitList(values.excludeWords)}
            max={60}
            error={error("excludeWords")}
          />
        </Fieldset>
        <Fieldset legend="Where and in what condition">
          <Input
            id={fieldId("categoryId")}
            name="categoryId"
            label="eBay category"
            inputmode="numeric"
            value={values.categoryId}
            hint={product?.rules.categoryName ?? "The ID of one eBay leaf category."}
            error={error("categoryId")}
          />
          {categoriesInUse.length > 0 && (
            <RadioGroup
              legend="Categories in use"
              name="categoryInUse"
              value=""
              options={[
                { value: "", label: "Keep the ID typed above" },
                ...categoriesInUse.map((category) => ({
                  value: category.categoryId,
                  label: `${category.categoryName ?? "Unnamed category"} (${category.categoryId})`,
                })),
              ]}
            />
          )}
          <CategoryHelp categories={categories} />
          <fieldset class="ia-fieldset">
            <legend class="ia-fieldset__legend type-ui-label">Condition</legend>
            <div class="app-row">
              {CONDITION_GROUPS.map((group) => (
                <Checkbox
                  id={`${fieldId("conditionGroups")}-${group}`}
                  name="conditionGroups"
                  value={group}
                  label={GROUP_LABEL[group]}
                  checked={values.conditionGroups.includes(group)}
                />
              ))}
            </div>
            {error("conditionGroups") && <p class="ia-field__error type-ui-body-sm">{error("conditionGroups")}</p>}
          </fieldset>
        </Fieldset>
        <Fieldset legend="Price">
          {/* app.css shows the fields of the checked rule, so a click changes them without script. */}
          <div class="app-price-rule app-stack">
            <RadioGroup
              legend="Price rule"
              name="priceMode"
              variant="cards"
              value={values.priceMode}
              options={[
                { value: "fixed", label: "Fixed max price", description: "Alert at or below the price you set." },
                {
                  value: "below_market",
                  label: "Below the typical asking price",
                  description: "Alert a set percent below what similar listings ask, never above your max.",
                },
              ]}
            />
            <Input
              id={fieldId("maxPrice")}
              name="maxPrice"
              label={
                <>
                  <span class="app-when-fixed">Max price (EUR)</span>
                  <span class="app-when-market">Never above (EUR)</span>
                </>
              }
              inputmode="decimal"
              value={values.maxPrice}
              hint="The landed price with shipping. With 'Below the typical asking price' this is the cap. Per GB when 'Price per GB' is on."
              error={error("maxPrice")}
            />
            <div class="app-when-market">
              <Input
                id={fieldId("belowMarketPct")}
                name="belowMarketPct"
                label="Percent below"
                inputmode="numeric"
                value={values.belowMarketPct}
                hint="Only for 'Below the typical asking price': 1 to 90."
                error={error("belowMarketPct")}
              />
            </div>
          </div>
        </Fieldset>
        <Fieldset legend="Email alerts to" description={`${alertTo} always gets them.`}>
          {people
            .filter((person) => person.status === "active")
            .map((person) => (
              <Checkbox
                id={`${fieldId("alertRecipientIds")}-${person.id}`}
                name="alertRecipientIds"
                value={person.id}
                label={person.email}
                checked={values.alertRecipientIds.includes(person.id)}
              />
            ))}
          {error("alertRecipientIds") && <p class="ia-field__error type-ui-body-sm">{error("alertRecipientIds")}</p>}
        </Fieldset>
        <details class="ia-acc app-disclosure">
          <summary class="ia-acc__trigger">
            <span class="type-title-sm">Advanced matching and alerts</span>
            <Icon name="chevron-down" size={16} className="ia-acc__chev" />
          </summary>
          <div class="app-stack">
            <RadioGroup legend="Speed" name="speed" variant="cards" value={values.speed} options={SPEEDS} />
            <Checkbox
              id={fieldId("priceDropCheck")}
              name="priceDropCheck"
              label="Price-drop check"
              description="Reads the cheapest listings once an hour: 24 calls a day."
              checked={values.priceDropCheck}
            />
            <Input
              id={fieldId("floor")}
              name="floor"
              label="Floor (EUR)"
              optional
              inputmode="decimal"
              value={values.floor}
              hint="The lowest plausible price. Left empty: 40 % of the typical asking price or of your max."
              error={error("floor")}
            />
            <Input
              id={fieldId("readCeiling")}
              name="readCeiling"
              label="Poll price ceiling (EUR)"
              optional
              inputmode="decimal"
              value={values.readCeiling}
              hint="The highest price the search reads. Left empty: twice your max, rounded up to EUR 100."
              error={error("readCeiling")}
            />
            <Checkbox id={fieldId("perGb")} name="perGb" label="Price per GB" description="Prices are per GB of the total size." checked={values.perGb} />
            <Input
              id={fieldId("unitMinTotal")}
              name="unitMinTotal"
              label="Minimum total size (GB)"
              inputmode="numeric"
              value={values.unitMinTotal}
              hint="Required with Price per GB."
              error={error("unitMinTotal")}
            />
            <Input
              id={fieldId("unitMaxTotal")}
              name="unitMaxTotal"
              label="Largest kit the price-drop check reads (GB)"
              optional
              inputmode="numeric"
              value={values.unitMaxTotal}
              hint="Left empty: 64 GB."
              error={error("unitMaxTotal")}
            />
            <TagsInput
              id={fieldId("warnWords")}
              name="warnWords"
              label="Warning words"
              hint="A match does not reject the listing; the alert names the word."
              value={splitList(values.warnWords)}
              max={30}
              error={error("warnWords")}
            />
            <Checkbox
              id={fieldId("useDefaultJunk")}
              name="useDefaultJunk"
              label="Default junk rules"
              description="Wanted ads, rentals, defective items, box only and bundles are filtered out."
              checked={values.useDefaultJunk}
            />
            <fieldset class="ia-fieldset">
              <legend class="ia-fieldset__legend type-ui-label">Junk rules this product turns off</legend>
              {DEFAULT_JUNK_RULES.map((rule) => (
                <Checkbox
                  id={`${fieldId("junkExceptions")}-${rule.id}`}
                  name="junkExceptions"
                  value={rule.id}
                  label={JUNK_REASON[rule.reason] ?? rule.id}
                  description={rule.entries.join(", ")}
                  checked={values.junkExceptions.includes(rule.id)}
                />
              ))}
            </fieldset>
            <Checkbox
              id={fieldId("accessoryCheck")}
              name="accessoryCheck"
              label="Accessory check"
              description="Rejects listings where 'für', 'for' or 'passend' stands before your must word."
              checked={values.accessoryCheck}
            />
            <Input
              id={fieldId("candidateCapPerDay")}
              name="candidateCapPerDay"
              label="Candidates per day"
              inputmode="numeric"
              value={values.candidateCapPerDay}
              hint="Listings a day that get the full check and a Claude call: 0 to 200."
              error={error("candidateCapPerDay")}
            />
            <RadioGroup
              legend="Buyer profile"
              name="buyerProfile"
              value={values.buyerProfile}
              options={[
                { value: "company", label: "Company", description: "The alert says whether the seller gives a VAT invoice." },
                { value: "private", label: "Private", description: "The alert leaves VAT out. Prices are compared gross either way." },
              ]}
            />
            <Checkbox
              id={fieldId("claudeRequired")}
              name="claudeRequired"
              label="Only alert after Claude has checked it"
              description="A listing Claude could not check is held instead of emailed."
              checked={values.claudeRequired}
            />
            <Input
              id={fieldId("conditionIds")}
              name="conditionIds"
              label="Exact condition IDs"
              optional
              value={values.conditionIds}
              hint={`Used instead of the condition boxes when filled in, separated by commas. ${CONDITION_GROUPS.map((group) => `${GROUP_LABEL[group]}: ${CONDITION_GROUP_IDS[group].join(", ")}`).join("; ")}.`}
              error={error("conditionIds")}
            />
            <Input
              id="product-testTitle"
              name="testTitle"
              label="Test a title"
              optional
              value={titleCheck?.title ?? ""}
              hint="Runs your rules on a listing title, without saving."
            />
            <Button type="submit" name="intent" value="test">
              Test title
            </Button>
            {titleCheck !== null && (
              <Callout tone={titleCheck.tone} title="Test result">
                <p>{titleCheck.text}</p>
              </Callout>
            )}
          </div>
        </details>
        <div class="app-row">
          <Button type="submit" variant="primary" name="intent" value="save">
            {product === null ? "Save draft" : "Save changes"}
          </Button>
          {/* The Button markup with the hook cost-preview.ts looks for: with script it fills the cost box in place. */}
          <button type="submit" name="intent" value="cost" data-cost-check="" class="ia-btn type-ui-strong ia-btn--secondary ia-btn--md">
            <span class="ia-btn__label">Check cost</span>
          </button>
          <Link href={product === null ? "/products" : `/products/${product.key}`}>Cancel</Link>
        </div>
        </div>
        {/* Spec 8.4: the market box sits in the right column from 1,024 px, below the form on smaller screens. */}
        <aside class="app-stack">
          <CostBox cost={cost} planTotal={planTotal} />
          {product === null || market === null ? (
            <Callout tone="info" title="Typical asking price">
              <p>Save the draft to see the typical asking price. This uses about 1 eBay call.</p>
            </Callout>
          ) : (
            <MarketSummary product={product} market={market} now={market.now} />
          )}
        </aside>
      </form>
    </>
  );
}

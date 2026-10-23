import {
  listPeople,
  listProducts,
  loadProduct,
  loadSettings,
  newestMarketValues,
  newestOkMarketValues,
  previewPlan,
  saveProductWithPlan,
  type ConfigContext,
  type DbPool,
  type LoadedSession,
  type StoredProduct,
} from "@ebay-sniper/db";
import { checkWordEntry, parseProductRules, PRODUCT_STATUSES, searchQuery, type Clock, type ProductIssue, type SettingsEnv } from "@ebay-sniper/domain";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../../session.js";
import { renderPage } from "../../shell.js";
import type { AssetManifest } from "../../ui/assets.js";
import { Banner } from "../../ui/feedback.js";
import { costReply, type CostReply } from "./cost.js";
import {
  fieldErrors,
  fieldsFromValues,
  formValuesFromBody,
  formValuesFromRules,
  newFormValues,
  splitList,
  type FormBody,
  type ProductFormValues,
} from "./form.js";
import { OverviewTab, PAGE_SCRIPTS, ProductPage, type ProductCost } from "./detail-view.js";
import { storedCallPlan } from "../budget/queries.js";
import { FORM_SCRIPTS, ProductForm, type Conflict } from "./form-view.js";
import { ProductList, STATUS_FILTERS } from "./list-view.js";
import { MarketBox } from "./market-view.js";
import { DealsTab, FilteredTab, FilteredTitles, HistoryTab } from "./tabs-view.js";
import { checkTitle, type TitleCheck } from "./title-check.js";
import {
  askMarketCheck,
  CHECK_NOW_PER_DAY,
  createCategoryRequest,
  DEAL_FILTERS,
  filteredCounts,
  filteredTitles,
  currentMarketValues,
  loadCategoryRequest,
  marketCheckOpen,
  marketTrend,
  newestListings,
  productActivity,
  productDeals,
  productRevisions,
  refusedMarketCheck,
  type CategoryRequest,
} from "./queries.js";

// What the product pages need from the app.
export type ProductPageDeps = {
  pool: DbPool;
  clock: Clock;
  assets: AssetManifest;
  // The .env ceilings the settings are clamped to (spec 2.5), for the plan check on save.
  settingsEnv: SettingsEnv;
  // Always among a product's alert recipients (spec 8.4).
  alertTo: string;
};

// The session guard lets only signed-in requests through to these routes.
function signedIn(c: Context<AppEnv>): LoadedSession {
  const session = c.get("session");
  if (session === null) throw new Error("the product pages need a session");
  return session;
}

const csrfOf = (c: Context<AppEnv>): string => signedIn(c).session.csrfSecret;

// The posted text fields, repeated names (checkboxes) as lists. The form uploads no files.
async function formBody(c: Context<AppEnv>): Promise<FormBody> {
  const body = await c.req.parseBody({ all: true });
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === "string");
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, strings(value)]));
}

// A field that is no number gets the form's message; the parser's issues of the other fields come
// with it, so one post shows every problem.
function withParserIssues(fields: Record<string, unknown>, issues: readonly ProductIssue[]): ProductIssue[] {
  const parsed = parseProductRules(fields);
  const taken = new Set(issues.map((issue) => String(issue.path[0])));
  return [...issues, ...(parsed.ok ? [] : parsed.issues.filter((issue) => !taken.has(String(issue.path[0]))))];
}

type FormState = {
  product: StoredProduct | null;
  values: ProductFormValues;
  issues: readonly ProductIssue[];
  cost?: CostReply;
  conflict?: Conflict;
  categories?: CategoryRequest;
  titleCheck?: TitleCheck & { title: string };
};

// Spec 8.4 item 5: each category the stored products use, once, with a stored name when one has it.
function categoriesInUse(products: readonly StoredProduct[]): { categoryId: string; categoryName: string | null }[] {
  const byId = new Map<string, string | null>();
  for (const { rules } of products) byId.set(rules.categoryId, byId.get(rules.categoryId) ?? rules.categoryName);
  return [...byId].map(([categoryId, categoryName]) => ({ categoryId, categoryName }));
}

async function showForm(c: Context<AppEnv>, deps: ProductPageDeps, state: FormState, status: 200 | 409 | 422) {
  const now = deps.clock.now();
  const { product } = state;
  // Both: the values give the typical asking price, the ok values the limit (as on the product page).
  const [people, plan, products, market] = await Promise.all([
    listPeople(deps.pool),
    storedCallPlan(deps.pool, deps.settingsEnv),
    listProducts(deps.pool),
    product === null
      ? null
      : Promise.all([
          newestMarketValues(deps.pool, product.id, product.matchVersion),
          newestOkMarketValues(deps.pool, product.id, product.matchVersion, now),
        ]).then(([values, ok]) => ({ values, ok, now })),
  ]);
  return c.html(
    renderPage(c, deps, {
      title: state.product === null ? "Add product" : `Edit ${state.product.rules.name}`,
      active: "products",
      scripts: FORM_SCRIPTS,
      children: (
        <ProductForm
          product={state.product}
          values={state.values}
          errors={fieldErrors(state.issues, state.values)}
          people={people}
          alertTo={deps.alertTo}
          csrf={csrfOf(c)}
          cost={state.cost ?? null}
          planTotal={plan.total}
          market={market}
          categoriesInUse={categoriesInUse(products)}
          conflict={state.conflict ?? null}
          categories={state.categories ?? null}
          titleCheck={state.titleCheck ?? null}
        />
      ),
    }),
    status,
  );
}

// A path on this site only, never another host ("//evil.example").
const backPath = (value: unknown, fallback: string): string => (typeof value === "string" && /^\/(?![/\\])/.test(value) ? value : fallback);

// Saves are made as the person (spec 2.7: actor user:<uuid>).
// The Overview's cost line (spec 8.3): the plan with the product against the plan without it
// (archived drops it); a draft is counted as active.
async function productCost(deps: ProductPageDeps, product: StoredProduct): Promise<ProductCost> {
  const preview = (status: "active" | "archived") => previewPlan(deps.pool, { id: product.id, fields: { ...product.rules, status } }, deps.settingsEnv);
  const [without, active] = await Promise.all([preview("archived"), preview("active")]);
  if (!without.ok || !active.ok) throw new Error("the stored product rules no longer parse");
  const withIt = product.rules.status === "draft" ? active.after : without.before;
  return { draft: product.rules.status === "draft", calls: withIt.total - without.after.total, total: withIt.total };
}

const CHECK_LIMIT_NOTICE = `You have used your ${String(CHECK_NOW_PER_DAY)} market checks for today. You can check again after midnight.`;

// The Overview tab with the market box; `notice` is what a refused "Check market value" says.
async function showProduct(
  c: Context<AppEnv>,
  deps: ProductPageDeps,
  product: StoredProduct,
  view: { notice: string | null; banner?: string; status: 200 | 409 | 429 },
) {
  const now = deps.clock.now();
  const [values, ok, checking, refused, listings, trend] = await Promise.all([
    newestMarketValues(deps.pool, product.id, product.matchVersion),
    newestOkMarketValues(deps.pool, product.id, product.matchVersion, now),
    marketCheckOpen(deps.pool, product.id),
    refusedMarketCheck(deps.pool, product.id),
    newestListings(deps.pool, product.id, now),
    marketTrend(deps.pool, product.id, product.matchVersion, now),
  ]);
  return c.html(
    renderPage(c, deps, {
      title: product.rules.name,
      active: "products",
      scripts: PAGE_SCRIPTS,
      // Spec 8.4: without script the page asks again every 5 s while the check runs.
      ...(checking ? { refresh: { seconds: 5, url: `/products/${product.key}?auto=1`, withoutScriptOnly: true } } : {}),
      children: (
        <ProductPage product={product} tab="overview" csrf={csrfOf(c)}>
          {view.banner !== undefined && <Banner tone="danger">{view.banner}</Banner>}
          <OverviewTab product={product} cost={await productCost(deps, product)} />
          <MarketBox product={product} market={{ values, ok, checking, refused, listings, trend }} notice={view.notice} now={now} csrf={csrfOf(c)} />
        </ProductPage>
      ),
    }),
    view.status,
  );
}

function configContext(c: Context<AppEnv>, deps: ProductPageDeps): ConfigContext {
  const { person } = signedIn(c);
  return { at: deps.clock.now(), actor: `user:${person.id}`, userId: person.id, env: deps.settingsEnv };
}

// The form as posted, for a new product (null) or a stored one, as parser fields.
async function readForm(c: Context<AppEnv>, deps: ProductPageDeps, product: StoredProduct | null) {
  const body = await formBody(c);
  const posted = formValuesFromBody(body);
  // A picked suggestion sets the ID, and its name comes from the person's own request, never
  // from the post. Otherwise the stored category name stays while the ID does.
  const pick = body["categoryPick"]?.[0] ?? "";
  const request = pick === "" ? null : await loadCategoryRequest(deps.pool, body["categoryRequest"]?.[0] ?? "", signedIn(c).person.id);
  const suggested = request?.suggestions.find((suggestion) => suggestion.categoryId === pick);
  // A quick pick (spec 8.4 item 5) names a category a stored product uses; its name comes from there.
  const inUse = body["categoryInUse"]?.[0] ?? "";
  const picked = suggested ?? (inUse === "" ? undefined : categoriesInUse(await listProducts(deps.pool)).find((category) => category.categoryId === inUse));
  const values = picked === undefined ? posted : { ...posted, categoryId: picked.categoryId };
  const categoryName =
    picked !== undefined
      ? picked.categoryName
      : product !== null && values.categoryId.trim() === product.rules.categoryId
        ? product.rules.categoryName
        : null;
  const status = product?.rules.status ?? "draft";
  return { body, values, status, ...fieldsFromValues(values, { status, categoryName }) };
}

// Spec 5.3: the cost box. A draft is previewed as active, since a draft is not polled.
async function costOf(deps: ProductPageDeps, product: StoredProduct | null, form: Awaited<ReturnType<typeof readForm>>): Promise<CostReply> {
  const live = form.status === "active" || form.status === "paused";
  const fields = { ...form.fields, status: live ? form.status : "active" };
  const preview = await previewPlan(deps.pool, product === null ? { fields } : { id: product.id, fields }, deps.settingsEnv);
  return costReply(preview, { status: form.status, values: form.values });
}

// Spec 6.6 "Suggest category": a category_request with the search words, which poll-tick turns into
// a job. The form posts the request's id back, so a second press shows the result instead of asking
// again.
async function suggestCategory(c: Context<AppEnv>, deps: ProductPageDeps, product: StoredProduct | null, form: Awaited<ReturnType<typeof readForm>>) {
  const { values } = form;
  const words = splitList(values.searchWords).map((word) => checkWordEntry("search", word));
  const folded = words.flatMap((word) => (word.ok ? [word.folded] : []));
  if (folded.length === 0 || folded.length < words.length) {
    return showForm(c, deps, { product, values, issues: [{ path: ["searchWords"], message: "Enter valid search words first: the suggestion searches eBay for them." }] }, 422);
  }
  const userId = signedIn(c).person.id;
  const asked = await loadCategoryRequest(deps.pool, form.body["categoryRequest"]?.[0] ?? "", userId);
  const request = asked ?? (await createCategoryRequest(deps.pool, { userId, q: searchQuery(folded), at: deps.clock.now() }));
  return showForm(c, deps, { product, values, issues: [], categories: request }, 200);
}

// One post of the form: "Check cost" shows the cost box, "Save draft" or "Save changes" saves.
async function submitForm(c: Context<AppEnv>, deps: ProductPageDeps, product: StoredProduct | null) {
  const form = await readForm(c, deps, product);
  const { values, fields } = form;
  // "Suggest category" needs only the search words, so it comes before the field checks.
  if (form.body["intent"]?.[0] === "suggest") return suggestCategory(c, deps, product, form);
  if (form.issues.length > 0) return showForm(c, deps, { product, values, issues: withParserIssues(fields, form.issues) }, 422);
  // "Test title": the form's rules, saved or not, on the typed title; nothing is saved.
  if (form.body["intent"]?.[0] === "test") {
    const title = form.body["testTitle"]?.[0] ?? "";
    const parsed = parseProductRules(fields);
    if (!parsed.ok) return showForm(c, deps, { product, values, issues: parsed.issues }, 422);
    return showForm(c, deps, { product, values, issues: [], titleCheck: { title, ...checkTitle(parsed.value, title) } }, 200);
  }
  // "Check cost" without script: the same page with the cost box filled in, nothing saved.
  if (form.body["intent"]?.[0] === "cost") return showForm(c, deps, { product, values, issues: [], cost: await costOf(deps, product, form) }, 200);
  const save =
    product === null
      ? ({ kind: "create", fields } as const)
      : ({ kind: "update", id: product.id, version: Number(form.body["version"]?.[0]), fields } as const);
  const result = await saveProductWithPlan(deps.pool, save, configContext(c, deps));
  if (result.ok) return c.redirect(`/products/${result.product.key}`, 303);
  if (result.reason === "invalid") return showForm(c, deps, { product, values, issues: result.issues }, 422);
  // Spec 5.3: over 2,500 the save is rolled back; the cost box says by how much and what fits.
  if (result.reason === "over_budget") return showForm(c, deps, { product, values, issues: [], cost: await costOf(deps, product, form) }, 422);
  if (result.reason === "conflict" && product !== null) {
    // The form comes back on the version that is stored now, with what the person typed.
    const current = (await loadProduct(deps.pool, product.key)) ?? product;
    return showForm(c, deps, { product: current, values, issues: [], conflict: { changedBy: result.changedBy, changedAt: result.changedAt } }, 409);
  }
  return c.body(null, 409);
}

// cost-preview.ts posts the form after each change; the reply fills the box in place.
async function costJson(c: Context<AppEnv>, deps: ProductPageDeps, product: StoredProduct | null) {
  const form = await readForm(c, deps, product);
  if (form.issues.length > 0) return c.json(costReply({ ok: false, reason: "invalid", issues: form.issues }, form));
  return c.json(await costOf(deps, product, form));
}

// Spec 8.3 and 8.4: /products and everything under it. Admins and editors alike (spec 7.7).
export function productRoutes(deps: ProductPageDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const stored = (c: Context<AppEnv>) => loadProduct(deps.pool, c.req.param("key") ?? "");

  routes.get("/", async (c) => {
    const now = deps.clock.now();
    const [products, values, activity] = await Promise.all([
      listProducts(deps.pool),
      currentMarketValues(deps.pool, now),
      productActivity(deps.pool, now),
    ]);
    // Without a filter: every product but the archived ones.
    const filter = STATUS_FILTERS.find((f) => f.value === c.req.query("status"))?.value ?? "";
    const shown = products.filter((product) => (filter === "" ? product.rules.status !== "archived" : product.rules.status === filter));
    return c.html(
      renderPage(c, deps, {
        title: "Products",
        active: "products",
        scripts: ["menu", "dialog"],
        children: (
          <ProductList
            products={shown}
            anyProduct={products.length > 0}
            filter={filter}
            values={values}
            activity={activity}
            now={now}
            csrf={csrfOf(c)}
          />
        ),
      }),
    );
  });

  routes.get("/new", async (c) => {
    const { settings } = await loadSettings(deps.pool, deps.settingsEnv);
    const values = newFormValues({ buyerProfile: settings.defaultBuyerProfile, creatorId: signedIn(c).person.id });
    return showForm(c, deps, { product: null, values, issues: [] }, 200);
  });

  routes.post("/new", (c) => submitForm(c, deps, null));
  routes.post("/new/cost", (c) => costJson(c, deps, null));

  routes.get("/:key/edit", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    return showForm(c, deps, { product, values: formValuesFromRules(product.rules), issues: [] }, 200);
  });

  routes.post("/:key/edit", async (c) => {
    const product = await stored(c);
    return product === null ? c.notFound() : submitForm(c, deps, product);
  });

  routes.get("/:key", async (c) => {
    const product = await stored(c);
    return product === null ? c.notFound() : showProduct(c, deps, product, { notice: null, status: 200 });
  });

  routes.get("/:key/deals", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    const now = deps.clock.now();
    const show = DEAL_FILTERS.find((filter) => filter === c.req.query("show")) ?? null;
    const deals = await productDeals(deps.pool, product.key, now, show);
    return c.html(
      renderPage(c, deps, {
        title: `${product.rules.name}: deals`,
        active: "products",
        scripts: PAGE_SCRIPTS,
        children: (
          <ProductPage product={product} tab="deals" csrf={csrfOf(c)}>
            <DealsTab deals={deals} show={show} productKey={product.key} now={now} />
          </ProductPage>
        ),
      }),
    );
  });

  routes.get("/:key/filtered", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    const now = deps.clock.now();
    const [counts, titles] = await Promise.all([filteredCounts(deps.pool, product.key, now), filteredTitles(deps.pool, product.key, now)]);
    return c.html(
      renderPage(c, deps, {
        title: `${product.rules.name}: filtered out`,
        active: "products",
        scripts: PAGE_SCRIPTS,
        children: (
          <ProductPage product={product} tab="filtered" csrf={csrfOf(c)}>
            <FilteredTab counts={counts} />
            <FilteredTitles titles={titles} now={now} />
          </ProductPage>
        ),
      }),
    );
  });

  routes.get("/:key/history", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    const revisions = await productRevisions(deps.pool, product.id);
    return c.html(
      renderPage(c, deps, {
        title: `${product.rules.name}: history`,
        active: "products",
        scripts: PAGE_SCRIPTS,
        children: (
          <ProductPage product={product} tab="history" csrf={csrfOf(c)}>
            <HistoryTab revisions={revisions} />
          </ProductPage>
        ),
      }),
    );
  });

  // market-poll.ts asks every 3 s with X-Auto-Refresh, which leaves the session idle (spec 8.4).
  routes.get("/:key/market", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    return c.json({ checking: await marketCheckOpen(deps.pool, product.id) });
  });

  // "Check market value": a check_now request in the person's name (spec 2.4, 5.4).
  routes.post("/:key/market", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    const asked = await askMarketCheck(deps.pool, { productId: product.id, userId: signedIn(c).person.id, at: deps.clock.now() });
    if (asked === "limit") return showProduct(c, deps, product, { notice: CHECK_LIMIT_NOTICE, status: 429 });
    return c.redirect(`/products/${product.key}`, 303);
  });

  // The edit form's data-cost-preview URL.
  routes.post("/:key/edit/cost", async (c) => {
    const product = await stored(c);
    return product === null ? c.notFound() : costJson(c, deps, product);
  });

  // Pause, Resume, Archive and Activate (spec 8.3): the stored rules with another status, saved
  // on the version the page showed, through the same plan check as the form (spec 5.3).
  routes.post("/:key/status", async (c) => {
    const product = await stored(c);
    if (product === null) return c.notFound();
    const body = await c.req.parseBody();
    const status = PRODUCT_STATUSES.find((s) => s === body["status"]);
    if (status === undefined) return c.body(null, 400);
    const result = await saveProductWithPlan(
      deps.pool,
      { kind: "update", id: product.id, version: Number(body["version"]), fields: { ...product.rules, status } },
      configContext(c, deps),
    );
    if (result.ok) return c.redirect(backPath(body["back"], `/products/${product.key}`), 303);
    if (result.reason === "over_budget") {
      const banner = `Not activated: with this product the plan would be ${result.plan.total.toLocaleString("en-US")} eBay calls a day, over the 2,500 planned. Make it slower or pause another product first.`;
      return showProduct(c, deps, product, { notice: null, banner, status: 409 });
    }
    return c.body(null, 409);
  });

  return routes;
}

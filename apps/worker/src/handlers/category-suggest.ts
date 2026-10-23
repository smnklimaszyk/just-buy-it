import { takeExtraSnapshotSlot, type DbPool, type Queryable } from "@ebay-sniper/db";
import type { JobHandler } from "@ebay-sniper/db/queue";
import type { Clock } from "@ebay-sniper/domain";
import {
  buildCategorySearch,
  EbayError,
  type BrowseSearchPage,
  type BrowseSearchRequest,
  type CategoryCount,
  type ReserveEbayCall,
} from "@ebay-sniper/ebay";
import type { BrowseSearch, LogFn } from "./poll.js";

export type CategorySuggestDeps = {
  pool: DbPool;
  clock: Clock;
  reserve: ReserveEbayCall;
  createSearch: (reserve: ReserveEbayCall) => BrowseSearch;
  log: { info: LogFn; warn: LogFn };
};

// Spec 5.4: a category suggestion is shed like an extra snapshot, at 2,500 used units.
const SUGGEST_MIN_LEFT = 2500;
const SUGGESTIONS = 5;

// What category_request.result holds: the categories with the most matches, most first.
export type CategorySuggestion = { categoryId: string; categoryName: string | null; matchCount: number };

// Spec 6.6, "Suggest category": one Browse search for the request's words with the category
// refinements, and the 5 categories with the most matches stored on the request for the form.
// category_request.q is the search's q as searchQuery builds it from the search words.
export function createCategorySuggestHandler(deps: CategorySuggestDeps): JobHandler<"category-suggest"> {
  return async ({ requestId }, job) => {
    const claimed = await deps.pool.query<{ q: string }>(
      "UPDATE app.category_request SET status = 'running' WHERE id = $1 AND status IN ('open', 'queued') RETURNING q",
      [requestId],
    );
    const q = claimed.rows[0]?.q;
    if (q === undefined) return;
    const refuse = async (reason: string): Promise<void> => {
      await endRequest(deps.pool, requestId, "refused", null, deps.clock.now());
      deps.log.warn({ event: "category_suggest_refused", request_id: requestId, reason });
    };
    let request: BrowseSearchRequest;
    try {
      request = buildCategorySearch({ q });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      // The words are never logged.
      return refuse("invalid_words");
    }
    // Spec 5.2: suggestions share the 20 extra snapshots a day with created, rules changed and
    // check now, so the plan's market line holds.
    if (!(await takeExtraSnapshotSlot(deps.pool, deps.clock.now()))) return refuse("daily_cap");
    const search = deps.createSearch(deps.reserve);
    let page: BrowseSearchPage;
    try {
      page = await search(request, {
        callClass: "standard",
        purpose: "category_suggest",
        minLeft: SUGGEST_MIN_LEFT,
        signal: job.signal,
      });
    } catch (error) {
      // The person can ask again; a retry of the job would not help.
      if (error instanceof EbayError) return refuse(error.kind);
      await endRequest(deps.pool, requestId, "refused", null, deps.clock.now());
      throw error;
    }
    await endRequest(deps.pool, requestId, "done", { categories: topCategories(page.categories) }, deps.clock.now());
  };
}

function topCategories(categories: readonly CategoryCount[]): CategorySuggestion[] {
  return categories
    .map((category) => ({
      categoryId: category.categoryId,
      categoryName: category.categoryName ?? null,
      matchCount: category.matchCount ?? 0,
    }))
    .sort((a, b) => b.matchCount - a.matchCount || (a.categoryId < b.categoryId ? -1 : 1))
    .slice(0, SUGGESTIONS);
}

async function endRequest(
  db: Queryable,
  requestId: string,
  status: "done" | "refused",
  result: { categories: CategorySuggestion[] } | null,
  at: Date,
): Promise<void> {
  await db.query("UPDATE app.category_request SET status = $2, result = $3, done_at = $4 WHERE id = $1", [
    requestId,
    status,
    result === null ? null : JSON.stringify(result),
    at,
  ]);
}

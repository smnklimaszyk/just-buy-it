import { FEED_IDS } from "@ebay-sniper/domain";
import { updateFeed, type FeedPatch } from "@ebay-sniper/db";
import { failed, runChange, UsageError, wholeNumber, type OpsDeps } from "./change.js";

const SET_FIELDS: Record<string, (value: string) => FeedPatch> = {
  category: (value) => {
    if (!/^[0-9]{1,12}$/.test(value)) throw new UsageError("category must be an eBay category ID");
    return { categoryId: value };
  },
  // The Browse query builder checks the reserved characters when the worker uses it.
  q: (value) => {
    if (value.length === 0 || value.length > 100) throw new UsageError("q must be 1 to 100 characters");
    return { q: value };
  },
  price_ceiling_cents: (value) => ({ priceCeilingCents: wholeNumber("price_ceiling_cents", value) }),
  day_interval_s: (value) => ({ dayIntervalS: wholeNumber("day_interval_s", value) }),
  night_interval_s: (value) => ({ nightIntervalS: wholeNumber("night_interval_s", value) }),
  overflow_pages_per_day: (value) => ({ overflowPagesPerDay: wholeNumber("overflow_pages_per_day", value) }),
};

// `ops feeds pause|resume|set`. Every change writes audit_event in the same statement; set is
// refused when the daily call plan would go over its ceiling. Pausing is never refused.
export async function runFeedsCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    const [action, feedArg, field, value] = args;
    const feedId = FEED_IDS.find((id) => id === feedArg);
    if (feedId === undefined) throw new UsageError(`feed must be one of ${FEED_IDS.join(", ")}`);
    let patch: FeedPatch;
    if ((action === "pause" || action === "resume") && args.length === 2) {
      patch = { enabled: action === "resume" };
    } else {
      const parse = field === undefined ? undefined : SET_FIELDS[field];
      if (action !== "set" || parse === undefined || value === undefined || args.length !== 4) {
        throw new UsageError(
          `usage: feeds pause|resume <feed> or feeds set <feed> <field> <value>, fields: ${Object.keys(SET_FIELDS).join(", ")}`,
        );
      }
      patch = parse(value);
    }
    return await runChange(deps, { checkPlan: action === "set" }, (db, audit) =>
      updateFeed(db, feedId, patch, { ...audit, action: `feeds.${action}` }),
    );
  } catch (error) {
    return failed(deps, error);
  }
}

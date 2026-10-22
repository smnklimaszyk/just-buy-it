import { SEGMENTS } from "@ebay-sniper/domain";
import { listSegmentRules, updateSegmentRule, type SegmentRulePatch } from "@ebay-sniper/db";
import { callPlan, failed, runChange, UsageError, wholeNumber, withPool, type OpsDeps } from "./change.js";

// The check constraints of segment_rule decide which fields a per-item or per-GB rule needs.
const SET_FIELDS: Record<string, (value: string) => SegmentRulePatch> = {
  max_landed_cents: (value) => ({ maxLandedCents: wholeNumber("max_landed_cents", value) }),
  floor_cents: (value) => ({ floorCents: wholeNumber("floor_cents", value) }),
  max_cents_per_gb: (value) => ({ maxCentsPerGb: wholeNumber("max_cents_per_gb", value) }),
  min_cents_per_gb: (value) => ({ minCentsPerGb: wholeNumber("min_cents_per_gb", value) }),
  min_total_gb: (value) => ({ minTotalGb: wholeNumber("min_total_gb", value) }),
  sweep_q: (value) => {
    if (value.length === 0 || value.length > 100) throw new UsageError("sweep_q must be 1 to 100 characters");
    return { sweepQ: value };
  },
  candidate_cap_per_day: (value) => ({ candidateCapPerDay: wholeNumber("candidate_cap_per_day", value) }),
  enabled: (value) => {
    if (value !== "true" && value !== "false") throw new UsageError("enabled must be true or false");
    return { enabled: value === "true" };
  },
};

// `ops rules list` prints the rules and the daily call plan. `ops rules set <segment> <field>
// <value>` writes audit_event and bumps rule_version in the same statement, and is refused when the
// daily call plan is over its ceiling.
export async function runRulesCommand(args: readonly string[], deps: OpsDeps): Promise<number> {
  try {
    const [action, segmentArg, field, value] = args;
    if (action === "list" && args.length === 1) {
      return await withPool(deps, async (pool) => {
        for (const rule of await listSegmentRules(pool)) deps.out(JSON.stringify(rule));
        deps.out(JSON.stringify({ plan: await callPlan(pool) }));
        return 0;
      });
    }
    const segment = SEGMENTS.find((s) => s === segmentArg);
    const parse = field === undefined ? undefined : SET_FIELDS[field];
    if (action !== "set" || segment === undefined || parse === undefined || value === undefined || args.length !== 4) {
      throw new UsageError(
        `usage: rules list or rules set <segment> <field> <value>, fields: ${Object.keys(SET_FIELDS).join(", ")}`,
      );
    }
    const patch = parse(value);
    return await runChange(deps, { checkPlan: true }, (db, audit) =>
      updateSegmentRule(db, segment, patch, { ...audit, action: "rules.set" }),
    );
  } catch (error) {
    return failed(deps, error);
  }
}

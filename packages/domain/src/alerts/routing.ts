import type { FinalVerdict } from "../screening/verdict.js";

// pass: "PASS"; check: "CHECK" with a warning box; not_screened: "NOT SCREENED";
// claude_says_block: emailed, marked "CLAUDE SAYS BLOCK" with the reason (Q7);
// blocked_by_code: a code-verified scam floor, dashboard only.
export type AlertLabel = "pass" | "check" | "not_screened" | "claude_says_block" | "blocked_by_code";

export type AlertRoute = { sendEmail: boolean; label: AlertLabel; dashboardSection: "alerts" | "blocked" };

// Section 5.7 routing.
export function routeAlert(v: FinalVerdict): AlertRoute {
  if (v.blockedByCode) return { sendEmail: false, label: "blocked_by_code", dashboardSection: "blocked" };
  if (v.finalVerdict === "block") return { sendEmail: true, label: "claude_says_block", dashboardSection: "blocked" };
  if (!v.screened) return { sendEmail: true, label: "not_screened", dashboardSection: "alerts" };
  if (v.finalVerdict === "caution") return { sendEmail: true, label: "check", dashboardSection: "alerts" };
  return { sendEmail: true, label: "pass", dashboardSection: "alerts" };
}

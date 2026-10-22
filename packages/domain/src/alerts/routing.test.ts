import { describe, expect, it } from "vitest";
import { routeAlert } from "./routing.js";

describe("routeAlert (section 5.7)", () => {
  it.each([
    ["pass", { finalVerdict: "pass", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "match" }, { sendEmail: true, label: "pass", dashboardSection: "alerts" }],
    ["caution", { finalVerdict: "caution", modelVerdict: "pass", blockedByCode: false, screened: true, productMatch: "match" }, { sendEmail: true, label: "check", dashboardSection: "alerts" }],
    ["not screened", { finalVerdict: "caution", modelVerdict: null, blockedByCode: false, screened: false, productMatch: null }, { sendEmail: true, label: "not_screened", dashboardSection: "alerts" }],
    ["block from the model only", { finalVerdict: "block", modelVerdict: "block", blockedByCode: false, screened: true, productMatch: "match" }, { sendEmail: true, label: "claude_says_block", dashboardSection: "blocked" }],
    ["block with a code scam floor", { finalVerdict: "block", modelVerdict: "pass", blockedByCode: true, screened: true, productMatch: "match" }, { sendEmail: false, label: "blocked_by_code", dashboardSection: "blocked" }],
    ["not screened with a code scam floor", { finalVerdict: "block", modelVerdict: null, blockedByCode: true, screened: false, productMatch: null }, { sendEmail: false, label: "blocked_by_code", dashboardSection: "blocked" }],
  ] as const)("%s", (_name, verdict, expected) => {
    expect(routeAlert(verdict)).toEqual(expected);
  });
});

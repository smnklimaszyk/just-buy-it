import { PassThrough } from "node:stream";
import { createPool } from "@ebay-sniper/db";
import { describe, expect, it } from "vitest";
import { failed, type OpsDeps, refused, terminalQuestion } from "./change.js";

// Only the log is used by failed() and refused().
function logOnlyDeps(lines: Record<string, unknown>[], out: string[] = []): OpsDeps {
  const unused = (): never => {
    throw new Error("not used here");
  };
  return {
    loadEnv: unused,
    loadSettingsEnv: unused,
    loadAuthKey: unused,
    screeningEvals: [],
    createPool,
    clock: { now: () => new Date("2026-10-21T10:00:00.000Z") },
    out: (line) => out.push(line),
    ask: async () => "",
    log: { info: () => undefined, error: (entry) => lines.push(entry) },
  };
}

describe("refused", () => {
  it("logs the first letter and the domain of an address, never the full address (spec 7.9)", () => {
    const lines: Record<string, unknown>[] = [];

    expect(refused(logOnlyDeps(lines), { ok: false, reason: "not_found", email: "someone@example.org", ref: "K7QF" })).toBe(1);
    expect(lines).toEqual([{ event: "ops", step: "refused", reason: "not_found", email: "s…@example.org", ref: "K7QF" }]);
  });
});

describe("failed", () => {
  it("logs the SQLSTATE as err_code, since the logger hides any field named code", () => {
    const lines: Record<string, unknown>[] = [];
    const deps = logOnlyDeps(lines);
    const error = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint: "product_key_unique" });

    expect(failed(deps, error)).toBe(1);
    expect(lines).toEqual([
      { event: "ops", step: "failed", exit_code: 1, err_name: "Error", err_code: "23505", constraint: "product_key_unique" },
    ]);
  });
});

describe("terminalQuestion", () => {
  it("resolves with an empty answer when the input ends first, so `ops auth code < /dev/null` says no", async () => {
    const input = new PassThrough();
    const answer = terminalQuestion(input, new PassThrough())("Is this you? [y/N] ");
    input.end();

    expect(await answer).toBe("");
  });

  it("prints the question and resolves with the line typed in reply", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const printed: string[] = [];
    output.on("data", (chunk: Buffer) => printed.push(chunk.toString()));

    const answer = terminalQuestion(input, output)("Is this you? [y/N] ");
    input.write("y\n");

    expect(await answer).toBe("y");
    expect(printed.join("")).toBe("Is this you? [y/N] ");
  });
});

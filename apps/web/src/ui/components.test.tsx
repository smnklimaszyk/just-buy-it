import { describe, expect, it } from "vitest";
import REFERENCE_MARKUP from "./testing/reference-markup.json" with { type: "json" };
import { REFERENCE_CASES } from "./testing/reference-cases.js";
import { diffMarkup } from "./testing/markup.js";
import { renderCase } from "./testing/render-case.js";

const reference: Readonly<Record<string, string>> = REFERENCE_MARKUP;

// Each case is rendered by the port and by the design system's React reference
// (tools/sync-design-system reference). The snapshot records the port's markup.
describe("components against the design system's reference markup", () => {
  for (const c of REFERENCE_CASES) {
    it(c.id, () => {
      const ours = renderCase(c.node);
      const expected = reference[c.id];
      if (expected === undefined) throw new Error(`no reference markup for ${c.id}; run the reference tool`);

      const diff = diffMarkup(ours, expected);
      if (c.deviation) expect(diff, c.deviation).not.toEqual([]);
      else expect(diff).toEqual([]);
      expect(ours).toMatchSnapshot();
    });
  }
});

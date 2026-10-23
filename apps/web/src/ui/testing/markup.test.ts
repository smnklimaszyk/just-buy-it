import { describe, expect, it } from "vitest";
import { diffMarkup } from "./markup.js";

describe("diffMarkup", () => {
  it("finds no difference when only attribute order, entity style and self-closing form differ", () => {
    const ours = `<span class="ia-badge" title="it&#39;s"><svg viewBox="0 0 24 24" fill="none"><path d="M1 2"></path></svg>A &amp; B</span>`;
    const reference = `<span title="it&#x27;s" class="ia-badge"><svg fill="none" viewBox="0 0 24 24"><path d="M1 2"/></svg>A &amp; B</span>`;

    expect(diffMarkup(ours, reference)).toEqual([]);
  });

  it("reports a different class, a missing attribute, other text and another tag", () => {
    expect(diffMarkup(`<span class="ia-badge">A</span>`, `<span class="ia-chip">A</span>`)).toEqual([
      `/0 <span> class: "ia-badge" instead of "ia-chip"`,
    ]);
    expect(diffMarkup(`<button>A</button>`, `<button type="button">A</button>`)).toEqual([
      `/0 <button> type: undefined instead of "button"`,
    ]);
    expect(diffMarkup(`<p>A</p>`, `<p>B</p>`)).toEqual([`/0 <p>/0: "A" instead of "B"`]);
    expect(diffMarkup(`<a>A</a>`, `<button>A</button>`)).toEqual([`/0: <a> instead of <button>`]);
  });

  it("compares ids by the element they point to, not by their value", () => {
    const reference = `<div><label for=":r1:">Name</label><input id=":r1:" aria-describedby=":r1:-hint"/><p id=":r1:-hint">Hint</p></div>`;
    const ours = `<div><label for="name">Name</label><input id="name" aria-describedby="name-hint"/><p id="name-hint">Hint</p></div>`;
    const crossed = `<div><label for="name">Name</label><input id="name" aria-describedby="name"/><p id="name-hint">Hint</p></div>`;

    expect(diffMarkup(ours, reference)).toEqual([]);
    expect(diffMarkup(crossed, reference)).toEqual([`/0 <div>/1 <input> aria-describedby: "id1" instead of "id2"`]);
  });

  it("drops the reference's inline styles, allows form attributes the port adds, and reports anything else", () => {
    expect(diffMarkup(`<span class="ia-spinner"></span>`, `<span class="ia-spinner" style="width:16px"></span>`)).toEqual([]);
    expect(diffMarkup(`<input name="q" value="gpu" data-tags="" required=""/>`, `<input/>`)).toEqual([]);
    expect(diffMarkup(`<span style="width:16px"></span>`, `<span></span>`)).toEqual([
      `/0 <span> style: "width:16px" instead of undefined`,
    ]);
    expect(diffMarkup(`<a onclick="go()"></a>`, `<a></a>`)).toEqual([`/0 <a> onclick: "go()" instead of undefined`]);
  });

  it("treats attribute names without regard to case, as HTML does (React 18 writes maxLength and colSpan)", () => {
    expect(diffMarkup(`<td colspan="1"><textarea maxlength="300"></textarea></td>`, `<td colSpan="1"><textarea maxLength="300"></textarea></td>`)).toEqual([]);
  });
});

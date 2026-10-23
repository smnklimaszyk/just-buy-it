// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import REFERENCE_MARKUP from "../ui/testing/reference-markup.json" with { type: "json" };
import { diffMarkup } from "../ui/testing/markup.js";
import { addTag, enhanceTags, splitTags } from "./tags.js";

describe("tags", () => {
  it("reads the comma list the server rendered, trimming and dropping empty and repeated words", () => {
    expect(splitTags(" rtx 4090, founders,, rtx 4090 ,~fe ")).toEqual(["rtx 4090", "founders", "~fe"]);
    expect(splitTags("")).toEqual([]);
  });

  it("adds a typed word unless it is empty, already there, or the list is full", () => {
    expect(addTag(["a"], " b ", undefined)).toEqual(["a", "b"]);
    expect(addTag(["a"], "a", undefined)).toEqual(["a"]);
    expect(addTag(["a"], "  ", undefined)).toEqual(["a"]);
    expect(addTag(["a", "b"], "c", 2)).toEqual(["a", "b"]);
  });

  it("shows the server's words as chips while the form still posts the comma list", () => {
    const { field, chips, posted } = mount();

    expect(chips()).toEqual(["rtx 4090", "founders"]);
    expect(posted()).toEqual(["rtx 4090, founders"]);
    expect(field.value).toBe("");
  });

  it("adds the typed word on Enter or a comma, without submitting the form", () => {
    const { field, chips, posted } = mount();

    field.value = "fe";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    field.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(chips()).toEqual(["rtx 4090", "founders", "fe"]);
    expect(posted()).toEqual(["rtx 4090, founders, fe"]);
    expect(field.value).toBe("");
  });

  it("removes a word with its chip's labelled button and puts the focus back in the field", () => {
    const { field, chips, posted } = mount();

    document.querySelector<HTMLButtonElement>('button.ia-chip__x[aria-label="Remove founders"]')?.click();

    expect(chips()).toEqual(["rtx 4090"]);
    expect(posted()).toEqual(["rtx 4090"]);
    expect(document.activeElement).toBe(field);
  });

  it("builds each chip with the reference TagsInput's markup, close glyph included", () => {
    mount();
    const reference = REFERENCE_MARKUP["TagsInput/values"].match(/<span class="ia-chip[^"]*">.*?<\/span>/g) ?? [];
    const ours = [...document.querySelectorAll(".ia-chip")].map((c) => c.outerHTML);

    expect(ours).toHaveLength(2);
    expect(diffMarkup(ours[0] ?? "", (reference[0] ?? "").replaceAll("canon 85mm", "rtx 4090"))).toEqual([]);
    expect(diffMarkup(ours[1] ?? "", (reference[1] ?? "").replace("founders", "founders"))).toEqual([]);
  });

  it("takes a pasted comma list at once and keeps a draft left in the field when it loses focus", () => {
    const { field, chips, posted } = mount();

    field.value = "fe, 24gb";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(chips()).toEqual(["rtx 4090", "founders", "fe", "24gb"]);

    field.value = "oc";
    field.dispatchEvent(new FocusEvent("blur"));
    expect(posted()).toEqual(["rtx 4090, founders, fe, 24gb, oc"]);
  });

  it("removes the last word on Backspace in an empty field and shows the placeholder once none is left", () => {
    const { field, chips } = mount();

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));

    expect(chips()).toEqual([]);
    expect(field.placeholder).toBe("Add and press Enter");
  });

  it("enhances the page's fields as soon as the module loads", async () => {
    document.body.innerHTML = `<div class="ia-tags"><input name="q" value="a, b" data-tags=""/></div>`;
    vi.resetModules();

    await import("./tags.js");

    expect(document.querySelectorAll(".ia-chip")).toHaveLength(2);
  });
});

function mount() {
  document.body.innerHTML = `<form><div class="ia-tags"><input id="w" name="search" value="rtx 4090, founders" data-tags=""/></div></form>`;
  enhanceTags(document);
  const field = document.querySelector<HTMLInputElement>("#w");
  const form = document.querySelector("form");
  if (!field || !form) throw new Error("fixture missing");
  return {
    field,
    chips: () => [...document.querySelectorAll(".ia-chip")].map((c) => c.textContent),
    posted: () => new FormData(form).getAll("search"),
  };
}

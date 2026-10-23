// TagsInput: the server renders one text field with the words separated by commas.
// This script shows the words as chips while that field keeps posting the comma list.

export function splitTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(",")) {
    const word = part.trim();
    if (word && !out.includes(word)) out.push(word);
  }
  return out;
}

export function addTag(tags: readonly string[], draft: string, max: number | undefined): string[] {
  const word = draft.trim();
  if (!word || tags.includes(word) || (max !== undefined && tags.length >= max)) return [...tags];
  return [...tags, word];
}

const SVG = "http://www.w3.org/2000/svg";

/** The design system's 12 px "x" glyph, built with DOM calls (no markup strings). */
function closeIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  const attrs: Record<string, string> = {
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: "ia-icon",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of ["M18 6 6 18", "m6 6 12 12"]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function enhance(field: HTMLInputElement): void {
  const box = field.closest(".ia-tags");
  if (!(box instanceof HTMLElement)) return;
  const max = field.dataset["max"] ? Number(field.dataset["max"]) : undefined;
  let tags = splitTags(field.value);

  // The hidden field takes over the name and posts the comma list; the visible one is the draft.
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.name = field.name;
  field.removeAttribute("name");
  field.value = "";
  box.append(hidden);

  const render = () => {
    for (const chip of box.querySelectorAll(".ia-chip")) chip.remove();
    for (const tag of tags) {
      const chip = document.createElement("span");
      chip.className = "ia-chip ia-chip--static type-ui-label";
      chip.append(document.createTextNode(tag));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ia-chip__x";
      remove.setAttribute("aria-label", `Remove ${tag}`);
      remove.append(closeIcon());
      remove.addEventListener("click", () => {
        tags = tags.filter((t) => t !== tag);
        render();
        field.focus();
      });
      chip.append(remove);
      box.insertBefore(chip, field);
    }
    hidden.value = tags.join(", ");
    field.placeholder = tags.length ? "" : "Add and press Enter";
  };

  const take = () => {
    for (const word of splitTags(field.value)) tags = addTag(tags, word, max);
    field.value = "";
    render();
  };

  field.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !field.value && tags.length) {
      tags = tags.slice(0, -1);
      render();
      return;
    }
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    take();
  });
  field.addEventListener("input", () => {
    if (field.value.includes(",")) take();
  });
  field.addEventListener("blur", () => {
    if (field.value.trim()) take();
  });
  render();
}

export function enhanceTags(root: ParentNode): void {
  for (const field of root.querySelectorAll<HTMLInputElement>("input[data-tags]")) enhance(field);
}

// Module scripts run after the document is parsed. Node tests import the helpers without a DOM.
if (typeof document !== "undefined") enhanceTags(document);

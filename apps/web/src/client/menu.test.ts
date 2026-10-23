// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { enhanceMenus } from "./menu.js";

// The markup Menu renders (see the ui snapshot "Menu/open"), closed.
const MENU = `
  <details class="ia-menu-wrap" data-menu="">
    <summary aria-label="Actions" title="Actions" class="ia-iconbtn ia-iconbtn--quiet ia-iconbtn--md">...</summary>
    <div class="ia-menu ia-menu--end" aria-label="Actions">
      <a href="/edit" class="ia-menu__item type-ui-body"><span class="ia-menu__label">Edit</span></a>
      <div class="ia-menu__sep" role="separator"></div>
      <button type="submit" form="row" class="ia-menu__item type-ui-body"><span class="ia-menu__label">Pause</span></button>
      <a href="/archive" class="ia-menu__item type-ui-body is-danger"><span class="ia-menu__label">Archive</span></a>
    </div>
  </details>`;

function mount() {
  document.body.innerHTML = `${MENU}<p id="outside">Elsewhere</p>`;
  enhanceMenus(document);
  const details = document.querySelector("details");
  if (!details) throw new Error("fixture missing");
  return { details, items: [...document.querySelectorAll<HTMLElement>(".ia-menu__item")] };
}

describe("menu", () => {
  it("gives the menu and its items their roles, with the items out of the tab order", () => {
    const { items } = mount();

    expect(document.querySelector(".ia-menu")?.getAttribute("role")).toBe("menu");
    expect(items.map((i) => [i.getAttribute("role"), i.getAttribute("tabindex")])).toEqual([
      ["menuitem", "-1"],
      ["menuitem", "-1"],
      ["menuitem", "-1"],
    ]);
  });

  it("moves the focus to the first item when the menu opens, and between items with the arrow keys, Home and End", () => {
    const { details, items } = mount();
    const open = () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    };
    const key = (k: string) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

    open();
    expect(document.activeElement).toBe(items[0]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    key("End");
    expect(document.activeElement).toBe(items[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    key("Home");
    expect(document.activeElement).toBe(items[0]);
  });

  it("closes on Escape with the focus back on its button, and on a press outside it", () => {
    const { details, items } = mount();
    details.open = true;
    items[1]?.focus();

    items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(details.open).toBe(false);
    expect(document.activeElement).toBe(details.querySelector("summary"));

    details.open = true;
    items[0]?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(details.open).toBe(true);
    document.querySelector("#outside")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(details.open).toBe(false);
  });

  it("tells assistive tech that the button opens a menu, from the moment the module loads", async () => {
    document.body.innerHTML = MENU;
    vi.resetModules();

    await import("./menu.js");

    expect(document.querySelector("summary")?.getAttribute("aria-haspopup")).toBe("menu");
    expect(document.querySelector(".ia-menu")?.getAttribute("role")).toBe("menu");
  });
});

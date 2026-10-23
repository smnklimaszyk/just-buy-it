// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { enhanceDialogs } from "./dialog.js";

const PAGE = `
  <button id="open" type="button" commandfor="d" command="show-modal">Add person</button>
  <dialog id="d" class="ia-dialog ia-dialog--sm" data-modal="">
    <button id="close" type="button" commandfor="d" command="close">Cancel</button>
  </dialog>`;

describe("dialog", () => {
  it("opens a dialog as modal from its command button and closes it from the close command, where the browser has no invoker commands", () => {
    document.body.innerHTML = PAGE;
    enhanceDialogs(document);
    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("fixture missing");
    const showModal = vi.spyOn(dialog, "showModal");

    document.querySelector<HTMLButtonElement>("#open")?.click();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);

    document.querySelector<HTMLButtonElement>("#close")?.click();
    expect(dialog.open).toBe(false);
  });

  it("makes a dialog the server rendered open into a modal one, so focus stays inside and Escape works", () => {
    document.body.innerHTML = PAGE.replace(`data-modal=""`, `data-modal="" open=""`);
    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("fixture missing");
    const showModal = vi.spyOn(dialog, "showModal");

    enhanceDialogs(document);

    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
  });

  it("closes on a click on the backdrop but not on a click inside", () => {
    document.body.innerHTML = PAGE.replace(`data-modal=""`, `data-modal="" open=""`);
    enhanceDialogs(document);
    const dialog = document.querySelector("dialog");
    if (!dialog) throw new Error("fixture missing");

    document.querySelector("#close")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(true);

    dialog.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it("leaves command buttons to a browser that has invoker commands, and starts when the module loads", async () => {
    document.body.innerHTML = PAGE;
    Object.defineProperty(HTMLButtonElement.prototype, "command", { value: "", configurable: true });
    try {
      vi.resetModules();
      await import("./dialog.js");
      const dialog = document.querySelector("dialog");
      if (!dialog) throw new Error("fixture missing");
      const showModal = vi.spyOn(dialog, "showModal");

      document.querySelector<HTMLButtonElement>("#open")?.click();
      expect(showModal).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLButtonElement.prototype, "command");
    }

    document.body.innerHTML = PAGE.replace(`data-modal=""`, `data-modal="" open=""`);
    vi.resetModules();
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    await import("./dialog.js");
    expect(showModal).toHaveBeenCalledOnce();
  });
});

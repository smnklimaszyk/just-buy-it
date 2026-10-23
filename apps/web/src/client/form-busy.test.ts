// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceForms } from "./form-busy.js";

// Button markup as ui/core.tsx renders it.
const FORM = `<form action="/save" method="post">
  <button id="save" type="submit" class="ia-btn type-ui-strong ia-btn--primary ia-btn--md"><span class="ia-btn__label">Save changes</span></button>
</form>`;

function submitWith(button: HTMLButtonElement): SubmitEvent {
  const event = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: button });
  button.form?.dispatchEvent(event);
  return event;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("form-busy", () => {
  it("shows the reference's overlay spinner on the pressed button 300 ms after submit, not before", async () => {
    document.body.innerHTML = FORM;
    enhanceForms(document);
    const button = document.querySelector<HTMLButtonElement>("#save");
    if (!button) throw new Error("fixture missing");

    submitWith(button);
    await Promise.resolve();
    vi.advanceTimersByTime(299);
    expect(button.getAttribute("aria-busy")).toBeNull();

    vi.advanceTimersByTime(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-overlay-loading")).toBe(true);
    expect(button.querySelector(".ia-btn__spin .ia-spinner svg")).not.toBeNull();
  });

  it("refuses a second submit while the first is under way", async () => {
    document.body.innerHTML = FORM;
    enhanceForms(document);
    const button = document.querySelector<HTMLButtonElement>("#save");
    if (!button) throw new Error("fixture missing");

    expect(submitWith(button).defaultPrevented).toBe(false);
    await Promise.resolve();
    expect(submitWith(button).defaultPrevented).toBe(true);
  });

  it("leaves alone a submit that a page script takes over (theme.ts, cost-preview.ts)", async () => {
    document.body.innerHTML = FORM;
    enhanceForms(document);
    const button = document.querySelector<HTMLButtonElement>("#save");
    if (!button) throw new Error("fixture missing");
    document.querySelector("form")?.addEventListener("submit", (e) => e.preventDefault());

    submitWith(button);
    await Promise.resolve();
    vi.advanceTimersByTime(300);

    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("puts the spinner in place of a leading icon, as the reference's loading button does", async () => {
    document.body.innerHTML = `<form><button id="check" type="submit" class="ia-btn type-ui-strong ia-btn--secondary ia-btn--md"><svg class="ia-icon"></svg><span class="ia-btn__label">Check cost</span></button></form>`;
    enhanceForms(document);
    const button = document.querySelector<HTMLButtonElement>("#check");
    if (!button) throw new Error("fixture missing");

    submitWith(button);
    await Promise.resolve();
    vi.advanceTimersByTime(300);

    expect([...button.children].map((c) => c.className.toString())).toEqual(["ia-spinner", "ia-btn__label"]);
    expect(button.classList.contains("is-overlay-loading")).toBe(false);
  });

  it("is ready again when the browser shows the page from its back-forward cache", async () => {
    document.body.innerHTML = FORM;
    enhanceForms(document);
    const button = document.querySelector<HTMLButtonElement>("#save");
    if (!button) throw new Error("fixture missing");
    submitWith(button);
    await Promise.resolve();
    vi.advanceTimersByTime(300);

    // happy-dom's PageTransitionEvent is a plain Event, so `persisted` is set by hand.
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));

    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.querySelector(".ia-btn__spin")).toBeNull();
    expect(button.classList.contains("is-overlay-loading")).toBe(false);
    expect(submitWith(button).defaultPrevented).toBe(false);
  });

  it("watches the page's forms as soon as the module loads", async () => {
    document.body.innerHTML = FORM;
    vi.resetModules();
    await import("./form-busy.js");
    const button = document.querySelector<HTMLButtonElement>("#save");
    if (!button) throw new Error("fixture missing");

    submitWith(button);
    await Promise.resolve();
    vi.advanceTimersByTime(300);

    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});

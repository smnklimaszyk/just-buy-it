// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { enhanceOtp } from "./otp.js";

// The markup OtpInput renders (see the ui snapshot "OtpInput/eight").
const cell = (i: number) =>
  `<input class="ia-otp__cell type-title" name="code" inputmode="numeric" autocomplete="${i === 0 ? "one-time-code" : "off"}" maxlength="1" value="" aria-label="Digit ${i + 1} of 8"/>`;

function mount() {
  document.body.innerHTML = `<form><div class="ia-otp-wrap"><div class="ia-otp" role="group" aria-label="Sign-in code">${Array.from({ length: 8 }, (_, i) => cell(i)).join("")}</div></div></form>`;
  enhanceOtp(document);
  const cells = [...document.querySelectorAll<HTMLInputElement>(".ia-otp__cell")];
  return { cells, code: () => cells.map((c) => c.value).join("") };
}

describe("otp", () => {
  it("moves to the next cell after a digit", () => {
    const { cells } = mount();
    const [first, second] = cells;
    if (!first || !second) throw new Error("fixture missing");

    first.focus();
    first.value = "7";
    first.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.activeElement).toBe(second);
  });

  it("drops anything but a digit and then stays in the cell", () => {
    const { cells, code } = mount();
    const [first] = cells;
    if (!first) throw new Error("fixture missing");

    first.focus();
    first.value = "x";
    first.dispatchEvent(new Event("input", { bubbles: true }));

    expect(first.value).toBe("");
    expect(document.activeElement).toBe(first);
    expect(code()).toBe("");
  });

  it("spreads a pasted code over the cells, whatever cell has the focus and whatever is around the digits", () => {
    const { cells, code } = mount();
    const third = cells[2];
    if (!third) throw new Error("fixture missing");

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => " 1234-5678 " } });
    third.dispatchEvent(paste);

    expect(paste.defaultPrevented).toBe(true);
    expect(code()).toBe("12345678");
    expect(document.activeElement).toBe(cells[7]);
  });

  it("spreads a whole code that autofill puts into one cell (autocomplete=one-time-code)", () => {
    const { cells, code } = mount();
    const first = cells[0];
    if (!first) throw new Error("fixture missing");

    first.value = "24681357";
    first.dispatchEvent(new Event("input", { bubbles: true }));

    expect(code()).toBe("24681357");
  });

  it("goes back one cell on Backspace in an empty cell", () => {
    const { cells } = mount();
    const [first, second] = cells;
    if (!first || !second) throw new Error("fixture missing");

    second.focus();
    second.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));

    expect(document.activeElement).toBe(first);
  });

  it("submits the form once every cell holds a digit, by typing or by paste, and not before", () => {
    const { cells } = mount();
    const form = document.querySelector("form");
    if (!form) throw new Error("fixture missing");
    let submits = 0;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submits++;
    });

    cells.slice(0, 7).forEach((c, i) => {
      c.value = String(i);
      c.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(submits).toBe(0);

    const last = cells[7];
    if (!last) throw new Error("fixture missing");
    last.value = "9";
    last.dispatchEvent(new Event("input", { bubbles: true }));
    expect(submits).toBe(1);

    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "87654321" } });
    cells[0]?.dispatchEvent(paste);
    expect(submits).toBe(2);
  });

  it("starts on the page's code fields as soon as the module loads", async () => {
    mount();
    document.body.innerHTML = `<form><div class="ia-otp">${cell(0)}${cell(1)}</div></form>`;
    vi.resetModules();

    await import("./otp.js");
    const [first, second] = document.querySelectorAll<HTMLInputElement>(".ia-otp__cell");
    first?.focus();
    if (first) first.value = "3";
    first?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.activeElement).toBe(second);
  });
});

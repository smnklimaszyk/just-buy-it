// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { enhanceThemeToggle } from "./theme.js";

// The markup ThemeToggle renders on a light page (see ui/port-only.test.tsx).
const TOGGLE = `<form method="post" action="/theme" data-theme-toggle="">
  <input type="hidden" name="_csrf" value="tok-1"/><input type="hidden" name="theme" value="dark"/><input type="hidden" name="back" value="/products"/>
  <div class="ia-side-row"><button id="toggle" type="submit" class="ia-side type-ui-body">Dark theme</button></div>
</form>`;

function mount() {
  document.documentElement.setAttribute("data-theme", "light");
  document.head.innerHTML = `<meta name="color-scheme" content="light"/>`;
  document.body.innerHTML = TOGGLE;
  enhanceThemeToggle(document);
  const form = document.querySelector("form");
  if (!form) throw new Error("fixture missing");
  return form;
}

afterEach(() => vi.unstubAllGlobals());

describe("theme", () => {
  it("switches the page to the posted theme without a reload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const form = mount();

    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submit);

    expect(submit.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  });

  it("sends the form's fields form-encoded to its action, with the CSRF token as X-CSRF-Token and Accept: application/json", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchFn);
    const form = mount();

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/theme");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("tok-1");
    expect(new Headers(init.headers).get("Accept")).toBe("application/json");
    expect(String(init.body)).toBe("_csrf=tok-1&theme=dark&back=%2Fproducts");
  });

  it("then offers the other theme and sets color-scheme, so a second press switches back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const form = mount();

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('input[name="theme"]')?.value).toBe("light"));
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("dark");

    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
  });

  it("falls back to the plain form post when the background post is refused or fails, keeping the theme", async () => {
    for (const answer of [async () => new Response("Forbidden", { status: 403 }), async () => Promise.reject(new TypeError("offline"))]) {
      vi.stubGlobal("fetch", vi.fn(answer));
      const form = mount();
      const plainSubmit = vi.spyOn(form, "submit").mockImplementation(() => undefined);

      form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));

      await vi.waitFor(() => expect(plainSubmit).toHaveBeenCalledOnce());
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    }
  });

  it("takes over the toggle as soon as the module loads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    document.body.innerHTML = TOGGLE;
    vi.resetModules();
    await import("./theme.js");

    const submit = new SubmitEvent("submit", { bubbles: true, cancelable: true });
    document.querySelector("form")?.dispatchEvent(submit);

    expect(submit.defaultPrevented).toBe(true);
  });
});

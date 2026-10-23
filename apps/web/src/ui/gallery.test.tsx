import { describe, expect, it } from "vitest";
import { renderGallery } from "./testing/gallery.js";

// The gallery shows every reference case and the port's own pieces on one page, in the light and
// the dark theme. The two files are the light and dark snapshots, and the page the runtime check
// opens in a browser (see the V5a hand-off). Components render the same markup in both themes;
// only data-theme on <html>, color-scheme and the theme toggle's target differ, and tokens.css
// switches the colours on data-theme.
describe("component gallery", () => {
  it("renders the same components in the light and the dark theme", async () => {
    const light = renderGallery("light");
    const dark = renderGallery("dark");
    const neutral = (html: string, theme: string, other: string) =>
      html.replaceAll(`data-theme="${theme}"`, "THEME").replaceAll(`content="${theme}"`, "THEME").replace(`name="theme" value="${other}"`, "TARGET");

    expect(neutral(dark, "dark", "light")).toBe(neutral(light, "light", "dark"));
    await expect(light).toMatchFileSnapshot("__snapshots__/gallery.light.html");
    await expect(dark).toMatchFileSnapshot("__snapshots__/gallery.dark.html");
  });
});

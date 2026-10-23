// ThemeToggle (ui/document.tsx) posts to POST /theme and works without script.
// This script sends that post in the background and switches data-theme in place.

export function enhanceThemeToggle(root: ParentNode): void {
  for (const form of root.querySelectorAll<HTMLFormElement>("form[data-theme-toggle]")) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      // Accept: application/json asks POST /theme for a 204 instead of the 303 back to the page.
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json", "X-CSRF-Token": String(data.get("_csrf")) },
        body: new URLSearchParams([...data].map(([k, v]) => [k, String(v)])),
      }).catch(() => null);
      // Refused or offline: the plain post shows the server's answer (an error page or sign-in).
      if (!response?.ok) {
        form.submit();
        return;
      }
      const theme = String(data.get("theme"));
      document.documentElement.setAttribute("data-theme", theme);
      document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
      const next = form.querySelector<HTMLInputElement>('input[name="theme"]');
      if (next) next.value = theme === "dark" ? "light" : "dark";
    });
  }
}

if (typeof document !== "undefined") enhanceThemeToggle(document);

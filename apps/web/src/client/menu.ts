// Menu (ui/navigation.tsx) is a native <details> whose links and buttons work without script.
// This script makes it a real menu: roles, arrow keys, Escape, closing on an outside click.

/** Where the focus goes for a key, or null when the key does not move it. */
function nextIndex(key: string, current: number, count: number): number | null {
  if (key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowUp") return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function enhanceMenus(root: ParentNode): void {
  for (const details of root.querySelectorAll<HTMLDetailsElement>("details[data-menu]")) {
    const menu = details.querySelector<HTMLElement>(".ia-menu");
    const items = [...details.querySelectorAll<HTMLElement>(".ia-menu__item")];
    if (!menu) continue;
    details.querySelector("summary")?.setAttribute("aria-haspopup", "menu");
    menu.setAttribute("role", "menu");
    for (const item of items) {
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
    }
    details.addEventListener("toggle", () => {
      if (details.open) items[0]?.focus();
    });
    details.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !details.open) return;
      details.open = false;
      details.querySelector("summary")?.focus();
    });
    document.addEventListener("pointerdown", (e) => {
      if (details.open && !(e.target instanceof Node && details.contains(e.target))) details.open = false;
    });
    menu.addEventListener("keydown", (e) => {
      const next = nextIndex(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
      if (next === null) return;
      e.preventDefault();
      items[next]?.focus();
    });
  }
}

if (typeof document !== "undefined") enhanceMenus(document);

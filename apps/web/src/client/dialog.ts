// Native <dialog> elements (ui/overlays.tsx). Buttons open and close them with invoker commands
// (commandfor + command); this script does the same in browsers that do not have them yet.

export function enhanceDialogs(root: ParentNode): void {
  for (const dialog of root.querySelectorAll<HTMLDialogElement>("dialog[data-modal]")) {
    // A confirm page without script renders its dialog open, which is not modal; make it modal.
    if (dialog.open) {
      dialog.close();
      dialog.showModal();
    }
    // The dialog's content fills its box, so a press and click on the element itself is the scrim.
    let pressedOn: EventTarget | null = null;
    dialog.addEventListener("pointerdown", (e) => (pressedOn = e.target));
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog && pressedOn === dialog) dialog.close();
    });
  }
  if ("command" in HTMLButtonElement.prototype) return;
  for (const button of root.querySelectorAll<HTMLButtonElement>("button[commandfor]")) {
    button.addEventListener("click", () => {
      const dialog = document.getElementById(button.getAttribute("commandfor") ?? "");
      if (!(dialog instanceof HTMLDialogElement)) return;
      const command = button.getAttribute("command");
      if (command === "show-modal" && !dialog.open) dialog.showModal();
      else if (command === "close") dialog.close();
    });
  }
}

if (typeof document !== "undefined") enhanceDialogs(document);

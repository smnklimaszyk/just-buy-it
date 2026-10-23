// OtpInput: each cell posts one digit as `code`. This script moves between the cells,
// spreads a pasted code over them and submits the form once the last digit is in.

export function enhanceOtp(root: ParentNode): void {
  for (const group of root.querySelectorAll(".ia-otp")) enhanceGroup(group);
}

function enhanceGroup(group: Element): void {
  const cells = [...group.querySelectorAll<HTMLInputElement>(".ia-otp__cell")];
  const submitWhenComplete = () => {
    if (cells.every((c) => c.value)) cells[0]?.form?.requestSubmit();
  };
  // A pasted or autofilled code fills the cells from the first one.
  const spread = (digits: string) => {
    cells.forEach((c, j) => (c.value = digits[j] ?? ""));
    cells[Math.min(digits.length, cells.length) - 1]?.focus();
    submitWhenComplete();
  };
  cells.forEach((cell, i) => {
    cell.addEventListener("input", () => {
      const digits = cell.value.replace(/\D/g, "");
      if (digits.length > 1) return spread(digits.slice(0, cells.length));
      cell.value = digits;
      if (cell.value) cells[i + 1]?.focus();
      submitWhenComplete();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !cell.value) cells[i - 1]?.focus();
    });
    cell.addEventListener("paste", (e) => {
      const digits = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, cells.length);
      if (!digits) return;
      e.preventDefault();
      spread(digits);
    });
  });
}

if (typeof document !== "undefined") enhanceOtp(document);

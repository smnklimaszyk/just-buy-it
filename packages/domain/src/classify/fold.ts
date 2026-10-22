import { removeHiddenCharacters } from "../text.js";

// Section 4 folding: NFKC, lower case, zero-width and bidi characters removed, - _ / | + as
// spaces, spaces collapsed. Every title rule runs on this form.
export function foldTitle(title: string): string {
  return removeHiddenCharacters(title.normalize("NFKC"))
    .toLowerCase()
    .replace(/[-_/|+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

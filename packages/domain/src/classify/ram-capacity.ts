const B = "(?<![\\p{L}\\p{N}])";
const MODULES_X_SIZE = new RegExp(`${B}(\\d{1,2}) ?x ?(\\d{1,3}) ?gb(?!\\p{L})`, "gu");
const KIT_OF = new RegExp(`${B}kit of (\\d{1,2})(?!\\p{N})`, "u");
const SIZE = new RegExp(`${B}(\\d{1,4}) ?gb(?!\\p{L})`, "gu");

function sizes(text: string): number[] {
  return [...text.matchAll(SIZE)].map((m) => Number(m[1]));
}

// Rule 17: the total size of a RAM listing from its folded title (or the Kapazität specific).
// "2x16gb" gives n x size; "kit of 4" with a module size gives 4 x size; else the largest "<n>gb".
export function parseRamCapacityGb(folded: string): number | null {
  const products = [...folded.matchAll(MODULES_X_SIZE)].map((m) => Number(m[1]) * Number(m[2]));
  if (products.length > 0) return Math.max(...products);
  const found = sizes(folded);
  if (found.length === 0) return null;
  const kit = KIT_OF.exec(folded);
  if (kit) return Number(kit[1]) * Math.max(...found);
  return Math.max(...found);
}

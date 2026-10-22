// "EUR 1,075.63": integer cents as euros with thousands separators and two decimals.
export function formatEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const euros = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}EUR ${euros}.${String(abs % 100).padStart(2, "0")}`;
}

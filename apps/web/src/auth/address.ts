// The form of auth.app_user.email (check app_user_email_format) and of `ops auth`.
const ONE_ADDRESS = /^[^@\s]+@[^@\s]+$/;

// Spec 7.2: trimmed, lower case, NFC, at most 254 characters and exactly one @. No plus-address
// folding. null when the input is not one address.
export function normalizeAddress(raw: string): string | null {
  const email = raw.trim().toLowerCase().normalize("NFC");
  return email.length <= 254 && ONE_ADDRESS.test(email) ? email : null;
}

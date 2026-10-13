import "server-only";

/** Comma-separated list -> trimmed, lower-cased, empty entries dropped. */
export function parseEmailList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Case/whitespace-insensitive membership in OPERATOR_EMAILS (unset = nobody). */
export function isOperatorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseEmailList(process.env.OPERATOR_EMAILS).includes(
    email.trim().toLowerCase(),
  );
}

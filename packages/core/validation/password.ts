import { COMMON_PASSWORDS } from "./common-passwords";

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordIssue =
  "required" | "too_short" | "too_long" | "same_as_email" | "too_common" | "repeated";

const CONTROL = /[\p{Cc}]/u;
const COMMON = new Set(COMMON_PASSWORDS);

function isRepeated(chars: readonly string[]): boolean {
  const n = chars.length;
  if (chars.every((c) => c === chars[0])) return true;
  if (n % 2 === 0 && n >= 6) {
    const a = chars[0];
    const b = chars[1];
    for (let i = 0; i < n; i += 2) if (chars[i] !== a || chars[i + 1] !== b) return false;
    return true;
  }
  return false;
}

/**
 * Length 12 to 128 code points, no composition rules. The string is neither trimmed nor
 * normalised: it goes to the identity provider as typed. Never throws.
 */
export function checkPassword(
  password: unknown,
  email?: string | null,
): { ok: true } | { ok: false; issue: PasswordIssue } {
  if (typeof password !== "string" || password === "") return { ok: false, issue: "required" };
  if (password.length > 1024) return { ok: false, issue: "too_long" };
  if (CONTROL.test(password)) return { ok: false, issue: "required" };
  const chars = Array.from(password);
  if (chars.length < PASSWORD_MIN_LENGTH) return { ok: false, issue: "too_short" };
  if (chars.length > PASSWORD_MAX_LENGTH) return { ok: false, issue: "too_long" };
  const lower = password.toLowerCase();
  if (typeof email === "string" && email !== "") {
    const e = email.toLowerCase();
    const at = e.indexOf("@");
    const local = at > 0 ? e.slice(0, at) : e;
    if (lower === e || lower === local) return { ok: false, issue: "same_as_email" };
  }
  if (COMMON.has(lower)) return { ok: false, issue: "too_common" };
  if (isRepeated(chars)) return { ok: false, issue: "repeated" };
  return { ok: true };
}

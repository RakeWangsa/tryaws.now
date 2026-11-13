// R9/R10, review finding of 2026-11-13: the audited GET routes (audit export, KYC image) write an audit
// row, so a link on another site must not be able to trigger them in an admin's browser. A request is
// accepted only when the browser says it comes from the admin app itself. Order of evidence:
//   1. Sec-Fetch-Site, set by the browser and not by page script: only "same-origin" passes.
//   2. Otherwise Origin: it must equal APP_ORIGIN.
//   3. Otherwise Referer: its origin must equal APP_ORIGIN.
//   4. Otherwise nothing proves it, and the request is refused (R16, fail closed).
// A missing or malformed APP_ORIGIN refuses every request that has to be compared with it.
export function isSameOriginRequest(
  headers: Pick<Headers, "get">,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const expected = originOf(env["APP_ORIGIN"]);
  if (expected === null) return false;
  const origin = headers.get("origin");
  if (origin !== null) return originOf(origin) === expected;
  const referer = headers.get("referer");
  if (referer !== null) return originOf(referer) === expected;
  return false;
}

function originOf(value: string | undefined): string | null {
  if (value === undefined || value === "" || value === "null") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

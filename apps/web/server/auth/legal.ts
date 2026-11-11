// The versions of the three documents a sign-up accepts (open point 14). Placeholders: the legal
// content does not exist yet. Needs decision (legal wording): the owner supplies the versions and
// the checkbox wording; until then the stored version says "draft" and no launch gate may pass with it.
export const LEGAL_VERSIONS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "2026-11-draft",
    acceptable_use: "2026-11-draft",
    privacy: "2026-11-draft",
  });

/** Where the three consent boxes link to (open point 29): pages another task builds. */
export const LEGAL_PATHS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "/legal/terms",
    acceptable_use: "/legal/acceptable-use",
    privacy: "/legal/privacy",
  });

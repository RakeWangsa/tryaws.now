// The versions of the three documents a sign-up accepts (open point 14). WPU-Z8: they name the drafts of
// WPU-Z7 that the legal pages show ("Version: draft 1, 13 November 2026"), so a sign-up records which
// text was accepted; legal.test.ts ties the two together. Needs decision (legal wording): the owner
// approves the texts and the checkbox wording; until then the stored version says "draft" and no launch
// gate may pass with it. The version and the page's version line move together.
export const LEGAL_VERSIONS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "2026-11-13-draft-1",
    acceptable_use: "2026-11-13-draft-1",
    privacy: "2026-11-13-draft-1",
  });

/** Where the three consent boxes link to (open point 29): pages another task builds. */
export const LEGAL_PATHS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "/legal/terms",
    acceptable_use: "/legal/acceptable-use",
    privacy: "/legal/privacy",
  });

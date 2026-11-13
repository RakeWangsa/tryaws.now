// The versions of the three documents a sign-up accepts (open point 14). WPU-Z8: they name the version
// that the legal pages show, so a sign-up records which text was accepted; legal.test.ts ties the two
// together. WPU-Y6 (owner, 2026-11-14): the texts are approved: version 1 of 14 November 2026 ("Version
// 1, 14 November 2026"), no longer a draft. The version and the page's version line move together.
export const LEGAL_VERSIONS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "2026-11-14-1",
    acceptable_use: "2026-11-14-1",
    privacy: "2026-11-14-1",
  });

/** Where the three consent boxes link to (open point 29): pages another task builds. */
export const LEGAL_PATHS: Readonly<{ terms: string; acceptable_use: string; privacy: string }> =
  Object.freeze({
    terms: "/legal/terms",
    acceptable_use: "/legal/acceptable-use",
    privacy: "/legal/privacy",
  });

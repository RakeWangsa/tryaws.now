import type { PdfRenderer } from "./handler";

// Stands in for the headless PDF engine in handler tests and local runs: it returns the HTML bytes. The
// real engine (engines.ts, headless Chromium with packaged fonts, 3 and 9.3) is proven with fakes of the
// browser in engines.test.ts and by a manual staging VERIFY.
export function createFakePdfRenderer(): PdfRenderer {
  return { render: async (html) => new TextEncoder().encode(html) };
}

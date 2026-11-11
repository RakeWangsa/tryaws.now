import type { PdfRenderer } from "./handler";

// Stands in for the headless PDF engine in tests and local runs: it returns the HTML bytes. The real
// engine (headless Chromium with packaged fonts, 3 and 9.3) is a manual staging VERIFY; no PDF
// dependency is added here.
export function createFakePdfRenderer(): PdfRenderer {
  return { render: async (html) => new TextEncoder().encode(html) };
}

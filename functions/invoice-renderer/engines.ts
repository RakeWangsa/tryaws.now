import type { PdfRenderer, PdfStore } from "./handler";

// The two seams that are not wired in this task. Both fail closed (R16): a build without the engine or the
// bucket produces no PDF and no half result.
//
//  - PdfRenderer: headless Chromium with the packaged Bengali font (Noto Sans Bengali), 3 and 9.3. It is a
//    manual staging VERIFY (Bengali conjuncts and numerals shaped, layout against the sample invoice). No
//    PDF dependency is added until that is recorded with a reason (R17).
//  - PdfStore: put of one object to the invoices bucket through the S3 gateway endpoint (infra, WP0-T4).
export function loadPdfRenderer(): PdfRenderer {
  throw new Error("invoice-renderer: the pdf engine is not linked");
}

export function loadPdfStore(): PdfStore {
  throw new Error("invoice-renderer: the invoices bucket is not linked");
}

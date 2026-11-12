import type { PdfRenderer, PdfStore } from "./handler";

// The two seams that are not wired in this task. Both fail closed (R16): a build without the engine or the
// bucket produces no PDF and no half result.
//
//  - PdfRenderer: headless Chromium with the packaged Bengali font (Noto Sans Bengali), 3 and 9.3. It is a
//    manual staging VERIFY (Bengali conjuncts and numerals shaped, layout against the sample invoice). No
//    PDF dependency is added until that is recorded with a reason (R17).
//    REQUIREMENT when it is wired (security review of WPU-S8): the engine runs with JavaScript DISABLED
//    and with every network request aborted (request interception that aborts all requests, or no route
//    out of the function's network at all). The handler's markup check is a second line, not the first.
//  - PdfStore: put of one object to the invoices bucket through the S3 gateway endpoint (infra, WP0-T4).
export function loadPdfRenderer(): PdfRenderer {
  throw new Error("invoice-renderer: the pdf engine is not linked");
}

export function loadPdfStore(): PdfStore {
  throw new Error("invoice-renderer: the invoices bucket is not linked");
}

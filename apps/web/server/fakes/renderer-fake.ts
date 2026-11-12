import type { RendererPort } from "../renderer-invoke.ts";

// Development and test only. A renderer that returns a tiny valid PDF, so "Download PDF" can be seen
// without AWS. Reached only through the literal dynamic import in runtime.ts, which runs when the
// configuration says fakes (config.ts refuses that in staging and production). It is NOT a tenant check:
// the route reads the invoice for the session's customer before it asks (invoiceDocument).

const MINIMAL_PDF =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

export function devRenderer(): RendererPort {
  return {
    async render() {
      return { ok: true, pdf: new TextEncoder().encode(MINIMAL_PDF) };
    },
  };
}

// invoice-renderer: the only place that touches the process (console, engines). The logic is in handler.ts.
import { loadPdfRenderer, loadPdfStore } from "./engines";
import { createInvoiceRendererHandler, type RenderReport } from "./handler";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ((event: unknown) => Promise<RenderReport>) | undefined;

export const handler = async (event: unknown): Promise<RenderReport> => {
  if (inner === undefined) {
    inner = createInvoiceRendererHandler({
      pdf: loadPdfRenderer(),
      store: loadPdfStore(),
      log: (e) => console.log(JSON.stringify(e)),
    });
  }
  return inner(event);
};

// invoice-renderer: the only place that touches the process (console, engines). The logic is in handler.ts.
import { loadPdfRenderer, loadPdfStore } from "./engines";
import { createInvoiceRendererHandler, rendererTierOf, type RenderReport } from "./handler";

// Built on the first call, not at import; a failed build keeps nothing.
let inner: ReturnType<typeof createInvoiceRendererHandler> | undefined;

// The tier comes from the alias in the invoked ARN of the Lambda context, never from the event (WPU-B7 L3).
export const handler = async (
  event: unknown,
  context?: { readonly invokedFunctionArn?: string },
): Promise<RenderReport> => {
  if (inner === undefined) {
    inner = createInvoiceRendererHandler({
      pdf: loadPdfRenderer(),
      store: loadPdfStore(),
      log: (e) => console.log(JSON.stringify(e)),
    });
  }
  return inner(event, rendererTierOf(context?.invokedFunctionArn));
};

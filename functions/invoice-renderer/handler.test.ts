import { describe, expect, it } from "vitest";
import { renderInvoiceHtml, type InvoiceDocument } from "@tc/core";
import { createInvoiceRendererHandler, MAX_HTML_BYTES, type RendererDeps } from "./handler";
import { createFakePdfRenderer } from "./fake";

const customerId = "0190a000-0000-7000-8000-000000000001";
const invoiceId = "0190a000-0000-7000-8000-000000000002";

const doc: InvoiceDocument = {
  kind: "invoice",
  number: "TC-2026-000042",
  issuedAt: new Date("2026-11-11T05:00:00Z"),
  company: { name: "TiCON Cloud", address: ["Dhaka"] },
  customer: { name: "Rahim", address: null },
  lines: [
    {
      kind: "service",
      code: "aws",
      label: { en: "Cloud Server", bn: "ক্লাউড সার্ভার" },
      amountMinor: "100",
    },
  ],
  totalMinor: 100n,
};
const html = renderInvoiceHtml(doc, "bn");

function setup(over: Partial<RendererDeps> = {}) {
  const stored = new Map<string, Uint8Array>();
  const logs: Record<string, unknown>[] = [];
  const deps: RendererDeps = {
    pdf: createFakePdfRenderer(),
    store: { put: async (key, bytes) => void stored.set(key, bytes) },
    log: (e) => logs.push(e as unknown as Record<string, unknown>),
    ...over,
  };
  return { handler: createInvoiceRendererHandler(deps), stored, logs };
}

describe("invoice-renderer handler", () => {
  it("renders the HTML it is given and stores the result under the derived key", async () => {
    const { handler, stored } = setup();
    const r = await handler({ customerId, invoiceId, locale: "bn", html });
    expect(r).toEqual({
      ok: true,
      key: `invoices/${customerId}/${invoiceId}.bn.pdf`,
      bytes: expect.any(Number),
    });
    // the fake engine returns the HTML bytes
    expect(new TextDecoder().decode(stored.get(`invoices/${customerId}/${invoiceId}.bn.pdf`))).toBe(
      html,
    );
  });
  it("is idempotent: the same event writes the same key with the same bytes", async () => {
    const { handler, stored } = setup();
    const a = await handler({ customerId, invoiceId, locale: "bn", html });
    const b = await handler({ customerId, invoiceId, locale: "bn", html });
    expect(a).toEqual(b);
    expect(stored.size).toBe(1);
  });
  it.each([
    ["no object", null],
    ["a customer id that is no UUID", { customerId: "../x", invoiceId, locale: "en", html }],
    ["an invoice id that is no UUID", { customerId, invoiceId: "1", locale: "en", html }],
    ["an unknown locale", { customerId, invoiceId, locale: "fr", html }],
    ["no html", { customerId, invoiceId, locale: "en" }],
    ["empty html", { customerId, invoiceId, locale: "en", html: "" }],
    [
      "html over the size limit",
      { customerId, invoiceId, locale: "en", html: "a".repeat(MAX_HTML_BYTES + 1) },
    ],
  ])("refuses %s and writes nothing", async (_name, event) => {
    const { handler, stored } = setup();
    expect(await handler(event)).toEqual({ ok: false, reason: "invalid_event" });
    expect(stored.size).toBe(0);
  });
  it.each([
    "<img src=x>",
    '<link rel="stylesheet" href="a.css">',
    "<script>1</script>",
    "<p>https://example.com</p>",
    "<style>@import 'a.css'</style>",
    "<style>p{background:url(a.png)}</style>",
    '<p style="color:red">x</p>',
  ])("refuses HTML that refers to a resource or runs code: %s (R16)", async (bad) => {
    const { handler, stored } = setup();
    expect(await handler({ customerId, invoiceId, locale: "en", html: bad })).toEqual({
      ok: false,
      reason: "unsafe_html",
    });
    expect(stored.size).toBe(0);
  });
  it("a failed engine or store throws a fixed message and logs a fixed reason, no HTML, no ids (R14)", async () => {
    const boom = setup({
      pdf: {
        render: async () => {
          throw new Error(`secret ${customerId}`);
        },
      },
    });
    await expect(boom.handler({ customerId, invoiceId, locale: "en", html })).rejects.toThrow(
      "invoice-renderer: render failed",
    );
    const fail = setup({
      store: {
        put: async () => {
          throw new Error(`secret ${invoiceId}`);
        },
      },
    });
    await expect(fail.handler({ customerId, invoiceId, locale: "en", html })).rejects.toThrow(
      "invoice-renderer: store failed",
    );
    for (const log of [...boom.logs, ...fail.logs]) {
      const text = JSON.stringify(log);
      expect(text).not.toContain(customerId);
      expect(text).not.toContain(invoiceId);
      expect(text).not.toContain("TC-2026");
      expect(text).not.toContain("Rahim");
    }
  });
});

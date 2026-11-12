import { describe, expect, it } from "vitest";
import {
  MAX_PDF_BYTES,
  rendererPortFromEnv,
  rendererPortFromInvoker,
  type RendererInvoker,
} from "./renderer-invoke.ts";

const customerId = "0190a000-0000-7000-8000-000000000001";
const invoiceId = "0190a000-0000-7000-8000-000000000002";
const input = { customerId, invoiceId, locale: "en" as const, html: "<p>x</p>" };
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

function invoker(reply: { functionError?: boolean; payload: string } | Error) {
  const sent: string[] = [];
  const inv: RendererInvoker = {
    async invoke(payload) {
      sent.push(payload);
      if (reply instanceof Error) throw reply;
      return { functionError: reply.functionError ?? false, payload: reply.payload };
    },
  };
  return { inv, sent };
}

describe("renderer invoke port", () => {
  it("sends the ids, the locale, the html and returnBytes, and returns the PDF bytes", async () => {
    const { inv, sent } = invoker({
      payload: JSON.stringify({ ok: true, key: "k", bytes: 9, pdfBase64: b64("%PDF-1.4 x") }),
    });
    const out = await rendererPortFromInvoker(inv).render(input);
    expect(out.ok).toBe(true);
    expect(JSON.parse(sent[0] ?? "")).toEqual({ ...input, returnBytes: true });
    if (out.ok) expect(new TextDecoder().decode(out.pdf)).toBe("%PDF-1.4 x");
  });

  it("fails closed on every other shape and leaks no text", async () => {
    const cases: [Parameters<typeof invoker>[0], string][] = [
      [new Error("arn:aws:lambda:ap-south-1:123456789012:function:x"), "unavailable"],
      [{ functionError: true, payload: '{"errorMessage":"arn:aws"}' }, "unavailable"],
      [{ payload: "not json" }, "unavailable"],
      [{ payload: JSON.stringify({ ok: false, reason: "unsafe_html" }) }, "unavailable"],
      [{ payload: JSON.stringify({ ok: true, key: "k", bytes: 1 }) }, "not_ready"],
      [{ payload: JSON.stringify({ ok: true, pdfBase64: b64("not a pdf") }) }, "unavailable"],
      [{ payload: JSON.stringify({ ok: true, pdfBase64: "" }) }, "not_ready"],
      [
        {
          payload: JSON.stringify({
            ok: true,
            pdfBase64: b64(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(MAX_PDF_BYTES)])),
          }),
        },
        "not_ready",
      ],
    ];
    for (const [reply, error] of cases) {
      const out = await rendererPortFromInvoker(invoker(reply).inv).render(input);
      expect(out).toEqual({ ok: false, error });
    }
  });

  it("refuses ids that are not uuids before sending", async () => {
    const { inv, sent } = invoker({ payload: "{}" });
    const out = await rendererPortFromInvoker(inv).render({ ...input, invoiceId: "../x" });
    expect(out).toEqual({ ok: false, error: "validation" });
    expect(sent).toHaveLength(0);
  });

  it("is null without a usable function name, and builds the client lazily", async () => {
    expect(rendererPortFromEnv({})).toBeNull();
    expect(
      rendererPortFromEnv({ INVOICE_RENDERER_FUNCTION_NAME: "arn:aws:lambda:x:1:function:y" }),
    ).toBeNull();
    const built: string[] = [];
    const port = rendererPortFromEnv(
      { INVOICE_RENDERER_FUNCTION_NAME: "tc-staging-renderer", AWS_REGION: "ap-south-1" },
      (region, name) => {
        built.push(`${region}/${name}`);
        return invoker({ payload: JSON.stringify({ ok: true, pdfBase64: b64("%PDF-1") }) }).inv;
      },
    );
    expect(port).not.toBeNull();
    expect(built).toHaveLength(0);
    await port?.render(input);
    await port?.render(input);
    expect(built).toEqual(["ap-south-1/tc-staging-renderer"]);
  });
});

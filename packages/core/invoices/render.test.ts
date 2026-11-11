import { describe, expect, it } from "vitest";
import { InvoiceError, renderInvoiceHtml, type InvoiceDocument } from "./index";

const doc: InvoiceDocument = {
  kind: "invoice",
  number: "TC-2026-000042",
  issuedAt: new Date("2026-11-11T05:00:00Z"),
  company: { name: "TiCON Cloud", address: ["House 1, Road 2", "Dhaka"] },
  customer: { name: "Rahim & <Sons>", address: "Mirpur, Dhaka" },
  lines: [
    {
      kind: "service",
      code: "aws",
      label: {
        en: "Cloud Server, Amazon Lightsail instance",
        bn: "ক্লাউড সার্ভার, Amazon Lightsail instance",
      },
      amountMinor: "10000",
    },
    {
      kind: "step",
      code: "vat",
      label: { en: "VAT", bn: "ভ্যাট" },
      amountMinor: "550",
    },
  ],
  totalMinor: 10550n,
};

describe("renderInvoiceHtml", () => {
  it("is a complete document with one inline style element and no URL", () => {
    const html = renderInvoiceHtml(doc, "en");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toMatch(/https?:|url\(|@import|<link|<script|<img|\bsrc=|\bstyle=/i);
  });
  it("shows the number, the lines and the exact total", () => {
    const html = renderInvoiceHtml(doc, "en");
    expect(html).toContain("TC-2026-000042");
    expect(html).toContain("100.00");
    expect(html).toContain("5.50");
    expect(html).toContain("105.50");
    expect(html).toContain("Cloud Server, Amazon Lightsail instance");
    expect(html).toContain('lang="en"');
  });
  it("renders Bengali labels and Bengali digits in bn, but the number in Latin digits", () => {
    const html = renderInvoiceHtml(doc, "bn");
    expect(html).toContain('lang="bn"');
    expect(html).toContain("ক্লাউড সার্ভার");
    expect(html).toContain("১০৫.৫০");
    expect(html).toContain("TC-2026-000042");
    expect(html).toContain("১১-১১-২০২৬");
  });
  it("carries the AWS statements of 16.13 unchanged, with no endorsement claim", () => {
    const en = renderInvoiceHtml(doc, "en");
    expect(en).toContain("100% AWS infrastructure. Built on Amazon Lightsail.");
    expect(en).toContain(
      "Amazon Web Services, AWS, Amazon Lightsail and Amazon Route 53 are trademarks of Amazon.com, Inc. or its affiliates.",
    );
    expect(en).toContain("TiCON Cloud sells, bills and supports");
    const bn = renderInvoiceHtml(doc, "bn");
    expect(bn).toContain("১০০% AWS অবকাঠামো। Amazon Lightsail দিয়ে তৈরি।");
    expect(en).not.toMatch(/AWS Lightsail/);
  });
  it("escapes customer text, so it is never markup (R11)", () => {
    const html = renderInvoiceHtml(doc, "en");
    expect(html).toContain("Rahim &amp; &lt;Sons&gt;");
    expect(html).not.toContain("<Sons>");
  });
  it("never shows an AWS account id or an ARN, and carries no tc- resource name", () => {
    const html = renderInvoiceHtml(doc, "en");
    expect(html).not.toMatch(/arn:aws|\b\d{12}\b|tc-[a-z]+-/i);
  });
  it("a receipt says it is not a tax invoice", () => {
    const html = renderInvoiceHtml({ ...doc, kind: "receipt" }, "en");
    expect(html).toContain("Payment receipt");
    expect(html).toContain("not a tax invoice");
    expect(renderInvoiceHtml(doc, "en")).not.toContain("not a tax invoice");
  });
  it("is the same for the same input (pure)", () => {
    expect(renderInvoiceHtml(doc, "bn")).toBe(renderInvoiceHtml(doc, "bn"));
  });
  it("fails closed when the lines do not add up to the total (R16)", () => {
    expect(() => renderInvoiceHtml({ ...doc, totalMinor: 1n }, "en")).toThrow(InvoiceError);
  });
});

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { knownClasses } from "@tc/ui/class-inventory";
import { describe, expect, it, vi } from "vitest";
import { INVOICE_ANCHORS } from "./mockup-anchors.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-G4: /invoices and /invoices/[id] follow the shared mockup (U1) and show their states (U11).

const here = dirname(fileURLToPath(import.meta.url));
const mockupRoot = resolve(here, "../../../../../..", "design/mockup");
const tokens = (text: string): Set<string> => {
  const out = new Set<string>();
  for (const attribute of text.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const token of (attribute[1] ?? "").split(/\s+/)) if (token !== "") out.add(token);
  }
  return out;
};
const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("the invoice screens follow the shared mockup", () => {
  for (const row of INVOICE_ANCHORS) {
    it(`${row.state} / ${row.mockupFile}: ${row.why}`, () => {
      const inMockup = tokens(readFileSync(resolve(mockupRoot, row.mockupFile), "utf8"));
      expect(
        row.classes.filter((t) => !inMockup.has(t)),
        `not in ${row.mockupFile}`,
      ).toEqual([]);
      for (const locale of ["bn", "en"] as const) {
        const rendered = tokens(render(row.state, locale));
        expect(
          row.classes.filter((t) => !rendered.has(t)),
          `${row.state} in ${locale}`,
        ).toEqual([]);
      }
    });
  }

  it("every class of every rendered state is defined by the theme, Bootstrap, Font Awesome or tc.css", () => {
    const known = knownClasses();
    for (const [id, renderer] of Object.entries(STATE_RENDERERS)) {
      for (const locale of ["bn", "en"] as const) {
        const unknown = [...tokens(renderer(locale))].filter((t) => !known.has(t));
        expect(unknown, `${id} in ${locale}`).toEqual([]);
      }
    }
  });

  it("every state of a row has a renderer", () => {
    for (const row of INVOICE_ANCHORS) expect(STATE_RENDERERS[row.state]).toBeDefined();
  });
});

describe("/invoices", () => {
  it("lists number, date and exact total with a link to each invoice", () => {
    const out = render("invoices.ready");
    expect(out).toContain("TC-2026-000012");
    expect(out).toContain("690.00");
    expect(out).toContain("1,250.50");
    expect(out).toContain('href="/en/invoices/0190aaaa-0000-7000-8000-0000000000e1"');
  });
  it("pages with a keyset cursor: a next link on a full page, a link to the first page on the next", () => {
    expect(render("invoices.ready")).toContain("/en/invoices?after=2026-11");
    const second = render("invoices.page2");
    expect(second).toContain('href="/en/invoices"');
    expect(second).not.toContain("after=");
  });
  it("says that there is no invoice yet, and goes back from a cursor that leads to nothing", () => {
    expect(render("invoices.empty")).toContain("No invoices yet");
    expect(render("invoices.empty")).toContain('href="/en/wallet"');
    expect(render("invoices.stale_cursor")).toContain('href="/en/invoices"');
  });
  it("is in Bengali with Bengali digits for money and dates, and a Latin invoice number", () => {
    const out = render("invoices.ready", "bn");
    expect(out).toMatch(/[ঀ-৿]/);
    expect(out).toContain("৬৯০.০০");
    expect(out).toContain("TC-2026-000012");
  });
  it("fits a phone: the table is in table-responsive-lg and nothing sets a pixel width", () => {
    const out = render("invoices.ready");
    expect(out).toContain("table-responsive-lg");
    expect(out).not.toMatch(/\sstyle=/);
  });
});

describe("/invoices/[id]", () => {
  it("shows number, date, who is billed, each line in the language of the page and the total", () => {
    const en = render("invoice.ready");
    expect(en).toContain("Invoice TC-2026-000012");
    expect(en).toContain("Rahim");
    expect(en).toContain("AWS service price");
    expect(en).toContain("Bangladesh VAT");
    expect(en).toContain("600.00");
    expect(en).toContain("90.00");
    expect(en).toContain("690.00");
    const bn = render("invoice.ready", "bn");
    expect(bn).toContain("এডব্লিউএস সেবার মূল্য");
    expect(bn).toContain("৬৯০.০০");
  });
  it("links to the printable document in a new tab, safely", () => {
    const out = render("invoice.ready");
    expect(out).toContain('href="/en/invoices/0190aaaa-0000-7000-8000-0000000000e1/document"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });
  it("offers 'Download PDF' next to print, as a plain link to the pdf route (WPU-N1)", () => {
    const en = render("invoice.ready");
    expect(en).toContain('href="/en/invoices/0190aaaa-0000-7000-8000-0000000000e1/pdf"');
    expect(en).toContain("Download PDF");
    expect(en).toContain("Print or save as PDF");
    expect(en).not.toContain('role="alert"');
    const bn = render("invoice.ready", "bn");
    expect(bn).toContain("PDF ডাউনলোড করুন");
  });
  it("says why there is no PDF, in both languages, without any error text (WPU-N1)", () => {
    expect(render("invoice.pdf_unavailable")).toContain("could not be made now");
    expect(render("invoice.pdf_busy")).toContain("Too many PDF requests");
    expect(render("invoice.pdf_unavailable", "bn")).toContain("তৈরি করা যায়নি");
    expect(render("invoice.pdf_unavailable")).toContain('role="alert"');
  });
  it("says 'no name given' for a customer without a name", () => {
    expect(render("invoice.no_name")).toContain("No name given");
  });
  it("answers a missing invoice and another customer's invoice with the same words (R8)", () => {
    const out = render("invoice.not_found");
    expect(out).toContain("This invoice was not found");
    expect(out).not.toContain("TC-");
  });
  it("prints no total when the lines do not add up (R16)", () => {
    const out = render("invoice.unavailable");
    expect(out).toContain("cannot be shown now");
    expect(out).not.toMatch(/\d+\.\d{2}/);
  });
  it("offers the print or save as PDF action and names the Mushak-6.3 form (WPU-I1)", () => {
    const en = render("invoice.ready");
    expect(en).toContain("Print or save as PDF");
    expect(en).toContain("Mushak-6.3");
    const bn = render("invoice.ready", "bn");
    expect(bn).toContain("মূসক-৬.৩");
  });
  it("shows no invoice, no total and no number when the seller details are missing (R16)", () => {
    for (const locale of ["en", "bn"] as const) {
      const out = render("invoice.seller_missing", locale);
      expect(out).not.toMatch(/\d+\.\d{2}|[০-৯]+\.[০-৯]{2}/);
      expect(out).not.toContain("TC-");
      expect(out).not.toContain("/document");
    }
    expect(render("invoice.seller_missing")).toContain("is being prepared");
  });
  it("never shows an account id, an ARN or a bucket key (U6)", () => {
    for (const id of ["invoice.ready", "invoices.ready"]) {
      expect(render(id)).not.toMatch(/arn:aws|\b\d{12}\b|\.pdf|amazonaws|s3:/);
    }
  });
});

describe("WPU-C1: the credit note and the date of supply", () => {
  it("/invoices lists the credit note with a label of its own, in both languages", () => {
    const en = render("invoices.with_credit_note");
    expect(en).toContain("TC-CN-2026-000001");
    expect(en).toContain("Credit note");
    expect(en).toContain('href="/en/invoices/0190aaaa-0000-7000-8000-0000000000e3"');
    expect(en).toContain("TC-2026-000012");
    const bn = render("invoices.with_credit_note", "bn");
    expect(bn).toContain("ক্রেডিট নোট");
    // The plain list has no such label.
    expect(render("invoices.ready")).not.toContain("Credit note");
  });

  it("the credit note page names the original invoice, its date and the reason, and prints the Mushak-6.7 hint", () => {
    const en = render("invoice.credit_note");
    expect(en).toContain("Credit note TC-CN-2026-000001");
    expect(en).toContain("TC-2026-000012");
    expect(en).toContain("Order failed");
    expect(en).toContain("Mushak-6.7");
    expect(en).not.toContain("Date of supply");
    expect(en).toContain('href="/en/invoices/0190aaaa-0000-7000-8000-0000000000e3/document"');
    const bn = render("invoice.credit_note", "bn");
    expect(bn).toContain("ক্রেডিট নোট TC-CN-2026-000001");
    expect(bn).toContain("অর্ডার ব্যর্থ হয়েছে");
    expect(bn).toContain("মূসক-৬.৭");
  });

  it("the invoice page shows the date of supply next to the date of issue", () => {
    const en = render("invoice.ready");
    expect(en).toContain("Date of supply");
    expect(en).toContain("Date of issue");
    const bn = render("invoice.ready", "bn");
    expect(bn).toContain("সরবরাহের তারিখ");
    expect(bn).toContain("ইস্যুর তারিখ");
  });
});

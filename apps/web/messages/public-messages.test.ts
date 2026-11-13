import { forbiddenWording, messageKeys } from "@tc/ui";
import type { Messages } from "@tc/ui/runtime";
import { describe, expect, it } from "vitest";
import { webMessages } from "../i18n/messages.ts";
import { publicBn } from "./public-bn.ts";
import { publicEn } from "./public-en.ts";

describe("public site messages (WPP-T1 to WPP-T4)", () => {
  it("bn and en have the same keys, none empty, and no forbidden wording", () => {
    expect(messageKeys(publicBn)).toEqual(messageKeys(publicEn));
    expect(messageKeys(publicBn).length).toBeGreaterThan(150);
    for (const tree of [publicBn, publicEn]) {
      expect(forbiddenWording(tree)).toEqual([]);
      for (const key of messageKeys(tree)) {
        const value = key
          .split(".")
          .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], tree);
        expect(typeof value === "string" && value.trim().length > 0, key).toBe(true);
      }
    }
  });

  it("has at least ten questions, and the four required answers of 16.8", () => {
    const items = publicBn.Public.help.items;
    expect(Object.keys(items).length).toBeGreaterThanOrEqual(10);
    expect(publicEn.Public.help.items.realAws.a).toMatch(/^Yes, 100%/);
    expect(publicEn.Public.help.items.noAccount.a).toMatch(/^No\./);
    expect(publicEn.Public.help.items.billing.a).toMatch(/^MeghVPS/);
    expect(publicEn.Public.help.items.dataLocation.a).toMatch(/AWS Singapore/);
  });

  it("is composed in both locales with Bengali text in bn", () => {
    for (const locale of ["bn", "en"] as const) {
      expect(webMessages[locale]["Public"], locale).toBeDefined();
    }
    expect((webMessages.bn["Public"] as Messages)["crumb"]).toBeDefined();
    expect(publicBn.Public.home.heroTitle).toMatch(/[ঀ-৿]/);
  });
});

// WPU-Z7, owner decision 2026-11-13: support is the in-app request system. There is no support phone
// and no support e-mail (a deviation from 16.8, which asks for a phone and the company address).
describe("support through support requests, no phone and no e-mail (WPU-Z7)", () => {
  it("the support page has no phone or e-mail keys any more, in either locale", () => {
    for (const tree of [publicBn, publicEn]) {
      const keys = Object.keys(tree.Public.support);
      for (const gone of ["phoneTitle", "phonePending", "emailTitle", "emailPending"]) {
        expect(keys, gone).not.toContain(gone);
      }
    }
  });

  it("the FAQ says who bills and supports: MeghVPS, through support requests in the panel, no phone", () => {
    const { billing, support } = publicEn.Public.help.items;
    expect(billing.a).toMatch(/^MeghVPS\./);
    expect(billing.a).toContain("support requests in the panel");
    expect(billing.a).toContain("no support phone");
    expect(support.a).toContain("support request");
    expect(support.a).toContain("no support phone line or support email address");
    const bn = publicBn.Public.help.items;
    expect(bn.billing.a).toMatch(/^MeghVPS।/);
    expect(bn.billing.a).toContain("সাপোর্ট অনুরোধ");
    expect(bn.billing.a).toContain("ফোন লাইন নেই");
    expect(bn.support.a).toContain("সাপোর্ট অনুরোধ");
  });

  it("no public text holds a phone number or an e-mail address (the form's example address aside)", () => {
    for (const tree of [publicBn, publicEn]) {
      for (const key of messageKeys(tree)) {
        if (key.endsWith("emailPlaceholder")) continue;
        const value = String(
          key.split(".").reduce<unknown>((n, p) => (n as Record<string, unknown>)[p], tree),
        );
        expect(value, key).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
        expect(value, key).not.toMatch(/(?:[\d০-৯][\s-]?){10,}/);
      }
    }
  });
});

// WPU-Z7: the legal pages are full drafts in place of the one-line placeholders. Every section is
// numbered from 1, has a title and the paragraphs p1, p2, ...; a missing fact is a bracketed note in
// one form; nothing of the old placeholders is left. The owner approves the exact texts (manual proof
// wp9-t5-legal-final); until then the page shows the draft notice.
type LegalSection = Record<string, string>;
type LegalDocTree = { title: string; sections: Record<string, LegalSection> };
const legalDocs = (tree: typeof publicBn | typeof publicEn): Record<string, LegalDocTree> =>
  tree.Public.legal.docs as unknown as Record<string, LegalDocTree>;
const LOCALES = [
  ["bn", publicBn],
  ["en", publicEn],
] as const;
const GAP = { bn: /\[সিদ্ধান্ত বাকি: [^\]]+\]/g, en: /\[To be decided: [^\]]+\]/g } as const;
const OLD_PLACEHOLDER = /\[legal text[^\]]*pending\]|\[আইনি লেখা[^\]]*বাকি\]/i;
const latinDigits = (text: string): string =>
  text.replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - "০".charCodeAt(0)));

describe("legal drafts (WPU-Z7)", () => {
  it("has the four documents, and no placeholder of the old one-line texts is left", () => {
    for (const [locale, tree] of LOCALES) {
      const docs = legalDocs(tree);
      expect(Object.keys(docs).sort(), locale).toEqual([
        "acceptable-use",
        "privacy",
        "refund",
        "terms",
      ]);
      for (const key of messageKeys(tree.Public.legal)) {
        const value = String(
          key
            .split(".")
            .reduce<unknown>((n, p) => (n as Record<string, unknown>)[p], tree.Public.legal),
        );
        expect(value, `${locale} ${key}`).not.toMatch(OLD_PLACEHOLDER);
      }
    }
  });

  it("numbers the sections of each document from 1, each with a title and paragraphs p1, p2, ...", () => {
    for (const [locale, tree] of LOCALES) {
      for (const [name, doc] of Object.entries(legalDocs(tree))) {
        const sections = Object.entries(doc.sections);
        expect(sections.length, `${locale} ${name}`).toBeGreaterThanOrEqual(5);
        sections.forEach(([key, section], index) => {
          const where = `${locale} ${name}.${key}`;
          const parts = Object.keys(section);
          expect(parts[0], where).toBe("title");
          expect(parts.slice(1), where).toEqual(parts.slice(1).map((_, i) => `p${i + 1}`));
          expect(parts.length, `${where} has a paragraph`).toBeGreaterThan(1);
          expect(latinDigits(section["title"] as string), where).toMatch(
            new RegExp(`^${index + 1}\\. \\S`),
          );
        });
      }
    }
    // The same sections in the same order in both locales (the types check the keys, not the order).
    for (const name of Object.keys(legalDocs(publicBn))) {
      const bnKeys = Object.keys(legalDocs(publicBn)[name]!.sections);
      expect(Object.keys(legalDocs(publicEn)[name]!.sections), name).toEqual(bnKeys);
    }
  });

  it("marks every missing fact with one bracketed note form, the same notes in bn and en", () => {
    let notes = 0;
    for (const [name, doc] of Object.entries(legalDocs(publicEn))) {
      for (const [key, section] of Object.entries(doc.sections)) {
        for (const [part, en] of Object.entries(section)) {
          const bn = legalDocs(publicBn)[name]!.sections[key]![part] as string;
          const where = `${name}.${key}.${part}`;
          const enNotes = en.match(GAP.en) ?? [];
          const bnNotes = bn.match(GAP.bn) ?? [];
          expect(bnNotes.length, where).toBe(enNotes.length);
          // No other bracket: a gap note is the only bracketed text of a document.
          expect(en.replace(GAP.en, ""), where).not.toMatch(/[[\]]/);
          expect(bn.replace(GAP.bn, ""), where).not.toMatch(/[[\]]/);
          notes += enNotes.length;
        }
      }
    }
    expect(notes).toBeGreaterThan(0);
  });

  it("shows the notice 'Draft — awaiting final approval' until the owner approves the texts", () => {
    expect(publicEn.Public.legal.draftTitle).toBe("Draft — awaiting final approval");
    expect(publicBn.Public.legal.draftTitle).toBe("খসড়া — চূড়ান্ত অনুমোদনের অপেক্ষায়");
    expect(publicEn.Public.legal.version).toMatch(/draft/i);
    expect(publicBn.Public.legal.version).toContain("খসড়া");
  });

  it("says where the data is kept in the words of the FAQ (16.8), and names the abuse category of the form", () => {
    for (const [locale, tree] of LOCALES) {
      const docs = legalDocs(tree);
      expect(docs["privacy"]!.sections["storage"]!["p1"], locale).toBe(
        tree.Public.help.items.dataLocation.a,
      );
      expect(docs["acceptable-use"]!.sections["report"]!["p1"], locale).toContain(
        `“${tree.Public.support.form.categories.abuse}”`,
      );
    }
  });

  it("passes on the AWS rules of 16.8 in the acceptable use policy, in both locales", () => {
    const aupOf = (tree: typeof publicBn | typeof publicEn): string =>
      Object.values(legalDocs(tree)["acceptable-use"]!.sections)
        .flatMap((section) => Object.values(section))
        .join("\n");
    const rules = {
      en: [
        "AWS Acceptable Use Policy",
        "mine cryptocurrency",
        "AWS Service Terms, section 1.25",
        "AWS Service Terms, section 51.3",
        "video streaming",
        "Amazon Lightsail FAQ",
        "port 25 is closed",
        "AWS Customer Agreement, section 2.5",
      ],
      bn: [
        "AWS Acceptable Use Policy",
        "ক্রিপ্টোকারেন্সি মাইনিং",
        "AWS Service Terms, ধারা ১.২৫",
        "AWS Service Terms, ধারা ৫১.৩",
        "ভিডিও স্ট্রিমিং",
        "Amazon Lightsail FAQ",
        "পোর্ট ২৫ বন্ধ",
        "AWS Customer Agreement, ধারা ২.৫",
      ],
    } as const;
    for (const [locale, tree] of LOCALES) {
      for (const rule of rules[locale]) expect(aupOf(tree), `${locale} ${rule}`).toContain(rule);
    }
  });

  it("promises a tax invoice and a credit note only for purchases and renewals; charges by use are a gap note", () => {
    // Spec 9.3 and packages/core/invoices: a tax invoice for each purchase and each renewal, and a credit
    // note only for the full reversal of a charge with an issued invoice (credit-note.ts). Charges by use
    // (backup storage by the day, a static IP by the hour) get neither: an open owner decision (JOURNEY,
    // WPU-I2 ruling 5 and WPU-I5), so the drafts carry a gap note there instead of a promise.
    const words = {
      en: { purchase: "purchase", renewal: "renewal", byUse: /charges? by use/ },
      bn: { purchase: "কেনা", renewal: "নবায়ন", byUse: /ব্যবহারভিত্তিক/ },
    } as const;
    for (const [locale, tree] of LOCALES) {
      const { terms, refund } = legalDocs(tree);
      const promises = {
        "terms.wallet.p4": terms!.sections["wallet"]!["p4"]!,
        "terms.invoices.p1": terms!.sections["invoices"]!["p1"]!,
        "terms.invoices.p2": terms!.sections["invoices"]!["p2"]!,
        "refund.reversal.p1": refund!.sections["reversal"]!["p1"]!,
      };
      for (const [where, text] of Object.entries(promises)) {
        const promise = text.replace(GAP[locale], "");
        expect(promise, `${locale} ${where}`).toContain(words[locale].purchase);
        expect(promise, `${locale} ${where}`).toContain(words[locale].renewal);
        expect(promise, `${locale} ${where}`).not.toMatch(words[locale].byUse);
      }
      for (const [where, section] of Object.entries({
        "terms.invoices": terms!.sections["invoices"]!,
        "refund.reversal": refund!.sections["reversal"]!,
      })) {
        const notes = Object.values(section).flatMap((text) => text.match(GAP[locale]) ?? []);
        expect(
          notes.some((note) => words[locale].byUse.test(note)),
          `${locale} ${where}: a gap note on charges by use`,
        ).toBe(true);
      }
    }
  });
});

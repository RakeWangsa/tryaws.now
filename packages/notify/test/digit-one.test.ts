import { describe, expect, it } from "vitest";
import { layoutEmail } from "../templates/layout";

// WPU-F1: the Bengali digit one has its own font in a mail. A mail has inline CSS only (no style
// element), so the span carries the font in its style attribute, like every other rule of the mail.
const SPAN =
  "<span style=\"font-family:'Noto Sans Bengali','Hind Siliguri',Arial,sans-serif;\">১</span>";

describe("the Bengali email layout (WPU-F1)", () => {
  const base = {
    locale: "bn" as const,
    subject: "বিষয় ১",
    headline: "১টি সার্ভার তৈরি হয়েছে",
    paragraphs: ["আপনার ১২১ টাকা জমা হয়েছে।", "৩৪৫ ০ 1 টাকা"],
    button: { label: "দেখুন ১", url: "https://my.ticoncloud.test/servers" },
  };

  it("names Hind Siliguri first and Noto Sans Bengali second in every Bengali text rule", () => {
    const { html } = layoutEmail(base);
    expect(html).toContain("font-family:'Hind Siliguri','Noto Sans Bengali',Arial,sans-serif;");
    expect(html).not.toContain(
      "font-family:'Noto Sans Bengali','Hind Siliguri',Arial,sans-serif;line",
    );
  });

  it("wraps every ১ of the text, also inside ১২১, in the headline, paragraphs and button", () => {
    const { html } = layoutEmail(base);
    expect(html).toContain(`${SPAN}টি সার্ভার`);
    expect(html).toContain(`আপনার ${SPAN}২${SPAN} টাকা`);
    expect(html).toContain(`দেখুন ${SPAN}</a>`);
  });

  it("leaves the subject, the title, the link and the plain-text part alone, and the other digits", () => {
    const { html, text } = layoutEmail(base);
    expect(html).toContain("<title>বিষয় ১</title>");
    expect(html).toContain('href="https://my.ticoncloud.test/servers"');
    expect(text).toContain("১টি সার্ভার তৈরি হয়েছে");
    expect(text).not.toContain("<span");
    expect(html).toContain("৩৪৫ ০ 1 টাকা");
  });

  it("escapes first and wraps after: '<১>' stays inert", () => {
    const { html } = layoutEmail({ ...base, paragraphs: ["<১> & ১"] });
    expect(html).toContain(`&lt;${SPAN}&gt; &amp; ${SPAN}`);
    expect(html).not.toContain("<১>");
  });

  it("wraps nothing in an English mail", () => {
    const { html } = layoutEmail({ ...base, locale: "en", headline: "Done", paragraphs: ["১"] });
    expect(html).not.toContain(SPAN);
  });
});

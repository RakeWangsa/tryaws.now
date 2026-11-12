import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { webMessages } from "../../../../../i18n/messages.ts";
import { SupportForm } from "./SupportForm.tsx";

// WPU-B6: the "related resource" picker of /support/new. Names are customer text: React escapes them.
const never = async (): Promise<never> => {
  throw new Error("an action ran during a render");
};

const html = (locale: "bn" | "en", resources: { id: string; name: string }[]): string =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={webMessages[locale]} timeZone="Asia/Dhaka">
      <SupportForm action={never} resources={resources} />
    </NextIntlClientProvider>,
  );

describe("the related resource picker", () => {
  it.each(["bn", "en"] as const)("is a labelled select with an empty choice first in %s", (l) => {
    const out = html(l, [{ id: "0190aaaa-0000-7000-8000-000000000009", name: "web-1" }]);
    expect(out).toContain('name="relatedResourceId"');
    expect(out).toMatch(/<label[^>]*for="[^"]+"[^>]*>/);
    expect(out).toContain('<option value=""');
    expect(out).toContain('value="0190aaaa-0000-7000-8000-000000000009"');
    expect(out).toContain("web-1");
  });

  it("is not shown when the customer has no named resource", () => {
    expect(html("en", [])).not.toContain("relatedResourceId");
  });

  it("escapes the name of a resource", () => {
    const out = html("en", [{ id: "0190aaaa-0000-7000-8000-000000000009", name: "<b>x</b>" }]);
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

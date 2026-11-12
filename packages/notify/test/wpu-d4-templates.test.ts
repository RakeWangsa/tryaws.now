import { describe, expect, it } from "vitest";
import { planRows } from "../queue/notify";
import { NotifyError, TEMPLATE_IDS } from "../queue/types";
import { parseTemplateData, renderEmail, renderInApp } from "../templates/render";
import { IDS, SAMPLES } from "./samples";

// WPU-D4: the two templates that were missing, support_reply and waitlist_capacity_available.

const ctx = (locale: "bn" | "en") =>
  ({
    locale,
    numerals: locale === "bn" ? "beng" : "latn",
    panelOrigin: "https://my.ticoncloud.test",
  }) as const;

describe("support_reply", () => {
  const data = (body: string) =>
    parseTemplateData("support_reply", { requestId: IDS.request, body });

  it("is a queued template (not direct only)", () => {
    expect(TEMPLATE_IDS).toContain("support_reply");
  });

  it.each(["bn", "en"] as const)(
    "renders the text of the admin in %s, line breaks kept",
    (locale) => {
      const mail = renderEmail(
        "support_reply",
        data("Line one\nLine two\n\nNew paragraph"),
        ctx(locale),
      );
      expect(mail.html).toContain("Line one<br>Line two");
      expect(mail.text).toContain("Line one\nLine two");
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.html).toContain(`<html lang="${locale}">`);
      // the in-app item (not used by this template) stays one line
      expect(renderInApp("support_reply", data("a\nb"), ctx(locale)).body).not.toContain("\n");
    },
  );

  it("escapes markup in the text: nothing of it becomes HTML", () => {
    const mail = renderEmail(
      "support_reply",
      data(`<script>alert(1)</script> "x" & {amount}`),
      ctx("en"),
    );
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; {amount}",
    );
  });

  it("refuses a text with a control character other than a line break, an override or a null", () => {
    for (const body of ["a\u0000b", "a\u0007b", "a‮b", "a​b", "", "   ", "x".repeat(5001)]) {
      expect(() => data(body), JSON.stringify(body.slice(0, 8))).toThrow(NotifyError);
    }
    expect(data("a\r\nb").body).toBe("a\nb");
  });

  it("is sent as one email row for a visitor and for a customer, never as SMS", () => {
    const visitor = planRows({
      email: "visitor@example.test",
      template: "support_reply",
      data: SAMPLES.support_reply.data,
      dedupeKey: "support-reply-1",
    });
    expect(visitor.map((r) => r.channel)).toEqual(["email"]);
    const customer = planRows({
      customerId: IDS.customer,
      template: "support_reply",
      data: SAMPLES.support_reply.data,
      dedupeKey: "support-reply-1",
    });
    expect(customer.map((r) => r.channel)).toEqual(["email"]);
  });

  it("refuses an undeclared field and a text that holds a secret", () => {
    expect(() =>
      parseTemplateData("support_reply", { ...SAMPLES.support_reply.data, password: "x" }),
    ).toThrow(NotifyError);
    expect(() =>
      planRows({
        customerId: IDS.customer,
        template: "support_reply",
        data: { requestId: IDS.request, body: "your password: hunter2" },
        dedupeKey: "k",
      }),
    ).toThrow(NotifyError);
  });
});

describe("waitlist_capacity_available", () => {
  const data = (productFamily: string, region = "ap-southeast-1") =>
    parseTemplateData("waitlist_capacity_available", { productFamily, region });

  it("names the product and the location in bn and en, and links to the order page", () => {
    const bn = renderEmail("waitlist_capacity_available", data("linux_instance"), ctx("bn"));
    const en = renderEmail("waitlist_capacity_available", data("linux_instance"), ctx("en"));
    expect(bn.text).toContain("ক্লাউড সার্ভার");
    expect(bn.text).toContain("এশিয়া প্যাসিফিক (সিঙ্গাপুর)");
    expect(en.text).toContain("Cloud Server");
    expect(en.text).toContain("Asia Pacific (Singapore)");
    expect(bn.html).toContain("https://my.ticoncloud.test/servers/new");
    expect(en.html).toContain("https://my.ticoncloud.test/en/servers/new");
  });

  it("says that the capacity is not held for the customer", () => {
    const en = renderEmail("waitlist_capacity_available", data("database"), ctx("en"));
    expect(en.text).toMatch(/not (held|reserved)/i);
  });

  it("falls back to the dashboard for a family it does not know", () => {
    expect(renderInApp("waitlist_capacity_available", data("future_family"), ctx("en")).href).toBe(
      "https://my.ticoncloud.test/en/dashboard",
    );
  });

  it("refuses a family or a region that is not a plain key", () => {
    for (const [f, r] of [
      ["Bad Family", "ap-southeast-1"],
      ["linux_instance", "x y"],
      ["", "ap-south-1"],
    ] as const) {
      expect(() => data(f, r)).toThrow(NotifyError);
    }
  });

  it("is sent to a visitor by email only and to a customer by email and bell", () => {
    const base = {
      template: "waitlist_capacity_available" as const,
      data: SAMPLES.waitlist_capacity_available.data,
      dedupeKey: "waitlist:1",
    };
    expect(planRows({ ...base, email: "visitor@example.test" }).map((r) => r.channel)).toEqual([
      "email",
    ]);
    expect(planRows({ ...base, customerId: IDS.customer }).map((r) => r.channel)).toEqual([
      "email",
      "in_app",
    ]);
  });
});

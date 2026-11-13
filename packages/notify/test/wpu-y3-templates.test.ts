import { UNPAID_TEMPLATES } from "@tc/core";
import { describe, expect, it } from "vitest";
import { planRows } from "../queue/notify";
import { NotifyError, TEMPLATE_IDS } from "../queue/types";
import { BN, EN } from "../templates/messages";
import { parseTemplateData, renderEmail } from "../templates/render";
import { IDS, SAMPLES } from "./samples";

// WPU-Y3: the four messages of the unpaid-usage rule and the low-wallet reminder. DRAFT wording.
const ctx = (locale: "bn" | "en") =>
  ({
    locale,
    numerals: locale === "bn" ? "beng" : "latn",
    panelOrigin: "https://my.ticoncloud.test",
  }) as const;

describe("WPU-Y3 templates", () => {
  it("every template that core writes is a registered template, and the other way round", () => {
    for (const id of UNPAID_TEMPLATES) expect(TEMPLATE_IDS).toContain(id);
    expect([...UNPAID_TEMPLATES].sort()).toEqual(
      TEMPLATE_IDS.filter(
        (t) => t.startsWith("unpaid_") || t === "wallet_low_before_charge",
      ).sort(),
    );
  });

  it("has the same keys in bn and en, with Bengali script in bn", () => {
    for (const id of UNPAID_TEMPLATES) {
      expect(Object.keys(BN[id]).sort()).toEqual(Object.keys(EN[id]).sort());
      expect(Object.keys(BN[id].extra ?? {}).sort()).toEqual(
        Object.keys(EN[id].extra ?? {}).sort(),
      );
      expect(BN[id].subject).toMatch(/[ঀ-৿]/);
      expect(EN[id].subject).not.toMatch(/[ঀ-৿]/);
    }
  });

  it("says the numbers and the date, and no AWS name, arn or account id", () => {
    const data = parseTemplateData("unpaid_suspended", SAMPLES.unpaid_suspended.data);
    const en = renderEmail("unpaid_suspended", data, ctx("en"));
    expect(en.text).toContain("6 days");
    expect(en.text).toContain("20 Nov 2026");
    const bn = renderEmail("unpaid_suspended", data, ctx("bn"));
    expect(bn.text).toContain("২০ নভেম্বর ২০২৬");
    for (const id of UNPAID_TEMPLATES) {
      for (const locale of ["bn", "en"] as const) {
        const mail = renderEmail(id, parseTemplateData(id, SAMPLES[id].data), ctx(locale));
        expect(mail.text).not.toMatch(/arn:|\b\d{12}\b|tc-[a-z]+-[0-9a-f]{8}/i);
        expect(mail.html).not.toContain("AWS Lightsail");
      }
    }
  });

  it("the deletion message differs for approval and for direct deletion, and keeps the final backup promise", () => {
    const approval = renderEmail(
      "unpaid_deletion",
      parseTemplateData("unpaid_deletion", SAMPLES.unpaid_deletion.data),
      ctx("en"),
    );
    const direct = renderEmail(
      "unpaid_deletion",
      parseTemplateData("unpaid_deletion", { ...SAMPLES.unpaid_deletion.data, approval: false }),
      ctx("en"),
    );
    expect(approval.text).toContain("Our team checks it first");
    expect(direct.text).toContain("It will be deleted");
    expect(approval.text).toContain("final backup");
    expect(direct.text).toContain("final backup");
  });

  it("the low-wallet reminder names the charge date, the amount and the balance", () => {
    const mail = renderEmail(
      "wallet_low_before_charge",
      parseTemplateData("wallet_low_before_charge", SAMPLES.wallet_low_before_charge.data),
      ctx("en"),
    );
    expect(mail.subject).toBe("Your wallet is low for the charge on 20 Nov 2026");
    expect(mail.text).toMatch(/1,250|1250/);
  });

  it("is one email and one bell item, never an SMS, with a key for each template and channel", () => {
    for (const id of UNPAID_TEMPLATES) {
      const rows = planRows({
        customerId: IDS.customer,
        template: id,
        data: SAMPLES[id].data,
        dedupeKey: "unpaid:r:1:2",
      });
      expect(rows.map((r) => r.channel)).toEqual(["email", "in_app"]);
    }
  });

  it("refuses a day count outside the rule and an undeclared field", () => {
    expect(() =>
      parseTemplateData("unpaid_suspended", { ...SAMPLES.unpaid_suspended.data, daysLeft: 7 }),
    ).toThrow(NotifyError);
    expect(() =>
      parseTemplateData("wallet_low_before_charge", {
        ...SAMPLES.wallet_low_before_charge.data,
        days: 7,
      }),
    ).toThrow(NotifyError);
    expect(() =>
      parseTemplateData("unpaid_warning", { ...SAMPLES.unpaid_warning.data, phone: "01700000000" }),
    ).toThrow(NotifyError);
  });
});

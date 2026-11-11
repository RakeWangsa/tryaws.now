import { describe, expect, it } from "vitest";
import { planRows } from "../queue/notify";
import { DIRECT_ONLY_IDS, NotifyError, TEMPLATE_IDS, type TemplateId } from "../queue/types";
import { IDS, SAMPLES, WITHOUT_SMS } from "./samples";

// The table of 16.14, row by row. `sms` is "yes", "no", or the condition of the row.
type Sms = "yes" | "no" | "only_when";
const TABLE: ReadonlyArray<{ row: string; templates: readonly TemplateId[]; sms: Sms }> = [
  {
    row: "Sign-up and verification: Welcome (the email code is Cognito, the OTP is direct)",
    templates: ["welcome"],
    sms: "no",
  },
  { row: "KYC: received", templates: ["kyc_received"], sms: "no" },
  { row: "KYC: approved (SMS: approved)", templates: ["kyc_approved"], sms: "yes" },
  { row: "KYC: rejected with the reason", templates: ["kyc_rejected"], sms: "no" },
  { row: "Top-up verified: receipt", templates: ["topup_receipt"], sms: "no" },
  { row: "Order paid: invoice", templates: ["order_paid"], sms: "no" },
  { row: "Order failed and refunded", templates: ["order_failed_refunded"], sms: "no" },
  { row: "Resource ready", templates: ["resource_ready"], sms: "yes" },
  {
    row: "Renewal reminders at 7, 3 and 1 day (SMS at 1 day)",
    templates: ["renewal_reminder"],
    sms: "only_when",
  },
  { row: "Renewed: invoice", templates: ["renewed"], sms: "no" },
  { row: "Grace started", templates: ["grace_started"], sms: "yes" },
  { row: "Resource destroyed, backup kept", templates: ["resource_destroyed"], sms: "yes" },
  { row: "Backups purged", templates: ["backups_purged"], sms: "no" },
  { row: "Low balance, payment expired", templates: ["low_balance", "payment_expired"], sms: "no" },
  {
    row: "Security: new sign-in, password, TOTP, email or phone changed",
    templates: [
      "security_new_sign_in",
      "security_password_changed",
      "security_totp_changed",
      "security_email_changed",
      "security_phone_changed",
    ],
    sms: "yes",
  },
  {
    row: "Domain: contact pending, reminders 60, 30 and 7 days (SMS at 7)",
    templates: ["domain_contact_pending"],
    sms: "no",
  },
  { row: "Domain: renewal reminders", templates: ["domain_renewal_reminder"], sms: "only_when" },
];

const planned = (template: TemplateId, data: Record<string, unknown>) =>
  planRows({ customerId: IDS.customer, template, data, dedupeKey: "k" }).map((r) => r.channel);

describe("16.14 table", () => {
  it.each(TABLE)("$row", ({ templates, sms }) => {
    for (const t of templates) {
      const channels = planned(t, SAMPLES[t].data);
      // every trigger has an email and a bell item
      expect(channels).toContain("email");
      expect(channels).toContain("in_app");
      if (sms === "yes") expect(channels).toContain("sms");
      if (sms === "no") expect(channels).not.toContain("sms");
      if (sms === "only_when") {
        expect(channels).toContain("sms");
        expect(planned(t, WITHOUT_SMS[t] as Record<string, unknown>)).not.toContain("sms");
      }
      // every channel is its own row, with its own key
      expect(channels).toHaveLength(new Set(channels).size);
    }
  });

  it("covers every template exactly once", () => {
    const all = TABLE.flatMap((r) => r.templates);
    expect([...all].sort()).toEqual([...TEMPLATE_IDS].sort());
  });

  it("renewal reminders go out at 7, 3 and 1 day, domain reminders at 60, 30 and 7", () => {
    for (const days of [7, 3, 1]) {
      expect(() =>
        planned("renewal_reminder", { ...SAMPLES.renewal_reminder.data, days }),
      ).not.toThrow();
    }
    for (const days of [60, 30, 7]) {
      expect(() =>
        planned("domain_renewal_reminder", { ...SAMPLES.domain_renewal_reminder.data, days }),
      ).not.toThrow();
    }
    expect(() =>
      planned("renewal_reminder", { ...SAMPLES.renewal_reminder.data, days: 2 }),
    ).toThrow(NotifyError);
    expect(() =>
      planned("domain_renewal_reminder", { ...SAMPLES.domain_renewal_reminder.data, days: 14 }),
    ).toThrow(NotifyError);
  });

  it("the phone OTP and the Cognito codes are never queued (they would sit in the payload)", () => {
    for (const id of DIRECT_ONLY_IDS) {
      expect(() =>
        planRows({ customerId: IDS.customer, template: id as never, data: {}, dedupeKey: "k" }),
      ).toThrow(expect.objectContaining({ code: "direct_only" }));
    }
  });

  it("the sign-up row sends its email once for one customer, however often it is called", () => {
    const a = planRows({
      customerId: IDS.customer,
      template: "welcome",
      data: {},
      dedupeKey: IDS.customer,
    });
    const b = planRows({
      customerId: IDS.customer,
      template: "welcome",
      data: {},
      dedupeKey: IDS.customer,
    });
    expect(a.map((r) => r.dedupeKey)).toEqual(b.map((r) => r.dedupeKey));
  });
});

import { SUPPORT_REPLY_TEMPLATE } from "@tc/db";
import { WAITLIST_TEMPLATE } from "@tc/core";
import { describe, expect, it } from "vitest";
import { planRows } from "../queue/notify";
import { TEMPLATE_IDS } from "../queue/types";
import { waitlistNoticeToInput } from "../queue/waitlist";
import { IDS } from "./samples";

// WPU-D4: the names that other packages write into `notifications` are registered templates.

describe("template names used by the repositories", () => {
  it("support_reply of the admin repository is a registered template", () => {
    expect(TEMPLATE_IDS as readonly string[]).toContain(SUPPORT_REPLY_TEMPLATE);
  });
  it("the waitlist template of the core is a registered template", () => {
    expect(TEMPLATE_IDS as readonly string[]).toContain(WAITLIST_TEMPLATE);
  });
});

describe("waitlistNoticeToInput", () => {
  const notice = {
    template: WAITLIST_TEMPLATE,
    dedupeKey: "waitlist:0193f7c6-4d5e-7394-8f82-89abcdef0123",
    data: { productFamily: "linux_instance", region: "ap-southeast-1" },
  } as const;

  it("maps a customer entry to the customer id, not to an address", () => {
    const input = waitlistNoticeToInput({ ...notice, customerId: IDS.customer, email: null });
    expect(input.customerId).toBe(IDS.customer);
    expect("email" in input).toBe(false);
    expect(planRows(input).map((r) => r.channel)).toEqual(["email", "in_app"]);
  });

  it("maps a visitor entry to the address of the entry", () => {
    const input = waitlistNoticeToInput({ ...notice, customerId: null, email: "v@example.test" });
    expect(input.email).toBe("v@example.test");
    expect("customerId" in input).toBe(false);
    expect(planRows(input).map((r) => r.channel)).toEqual(["email"]);
  });

  it("keeps the key of the entry, so a second notice for it is a no-op", () => {
    const a = planRows(waitlistNoticeToInput({ ...notice, customerId: IDS.customer, email: null }));
    const b = planRows(waitlistNoticeToInput({ ...notice, customerId: IDS.customer, email: null }));
    expect(a.map((r) => r.dedupeKey)).toEqual(b.map((r) => r.dedupeKey));
  });
});

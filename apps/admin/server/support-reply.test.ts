import { TEMPLATE_IDS } from "@tc/notify";
import { SUPPORT_REPLY_TEMPLATE } from "@tc/db";
import { expect, it } from "vitest";
import { SUPPORT_REPLY_ENABLED } from "./support-reply.ts";

// WPU-D4: the reply is switched on only because the template it writes is registered.
it("replyByEmail is enabled and the template it writes is registered in the notifier", () => {
  expect(TEMPLATE_IDS as readonly string[]).toContain(SUPPORT_REPLY_TEMPLATE);
  expect(SUPPORT_REPLY_ENABLED).toBe(true);
});

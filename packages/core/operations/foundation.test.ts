import * as db from "@tc/db";
import { expect, it } from "vitest";
import * as core from "./index";

it("@tc/core re-exports the kinds of @tc/db and does not copy them", () => {
  expect(core.OPERATION_KINDS).toBe(db.OPERATION_KINDS);
  expect(core.OPERATION_KIND_INFO).toBe(db.OPERATION_KIND_INFO);
  expect(core.requiresApproval).toBe(db.requiresApproval);
  expect(core.readApprovalUntil).toBe(db.readApprovalUntil);
  expect(core.APPROVAL_UNTIL).toBe(db.APPROVAL_UNTIL);
});

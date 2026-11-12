import { expect, it } from "vitest";
import {
  APPROVAL_UNTIL,
  OPERATION_KIND_INFO,
  OPERATION_KINDS,
  SIBLING_BLOCKING_STATES,
  isDestructive,
  isOperationKind,
  requiresApproval,
} from "../operations/kinds";

it("every kind has one row of info and nothing else has", () => {
  expect(Object.keys(OPERATION_KIND_INFO).sort()).toEqual([...OPERATION_KINDS].sort());
  expect(OPERATION_KINDS).toHaveLength(32);
  expect(OPERATION_KINDS).toContain("rename");
  expect(OPERATION_KINDS).toContain("reject_operation");
});

it("the destructive kinds of R13 are destroy, purge_snapshots and delete_backup", () => {
  expect(OPERATION_KINDS.filter(isDestructive).sort()).toEqual([
    "delete_backup",
    "destroy",
    "purge_snapshots",
  ]);
});

it("a lifecycle kind has its own adapter method, reject_operation is run by the engine, and every other kind is an action", () => {
  const own = {
    create: "create",
    suspend: "suspend",
    resume: "resume",
    final_snapshot: "finalSnapshot",
    destroy: "destroy",
    purge_snapshots: "purgeSnapshots",
    reject_operation: "engine",
  } as const;
  for (const kind of OPERATION_KINDS) {
    expect(OPERATION_KIND_INFO[kind].method, kind).toBe(
      kind in own ? own[kind as keyof typeof own] : "action",
    );
  }
});

it("a customer may request the actions of 16.10 and nothing that the purchase, the lifecycle or an admin makes", () => {
  expect(OPERATION_KINDS.filter((k) => OPERATION_KIND_INFO[k].customerRequestable).sort()).toEqual([
    "attach_disk",
    "attach_static_ip",
    "change_dns_record",
    "create_backup",
    "create_db_snapshot",
    "delete_access_key",
    "delete_backup",
    "deploy_containers",
    "destroy",
    "detach_disk",
    "detach_static_ip",
    "reboot",
    "refresh_certificate",
    "rename",
    "request_certificate",
    "reset_cache",
    "scale_container",
    "set_auto_backup",
    "set_bucket_access",
    "set_bucket_versioning",
    "set_db_options",
    "set_lb_attributes",
    "set_ports",
    "set_targets",
    "start",
    "stop",
  ]);
  expect(OPERATION_KINDS.filter((k) => !OPERATION_KIND_INFO[k].customerRequestable).sort()).toEqual(
    ["create", "final_snapshot", "purge_snapshots", "reject_operation", "resume", "suspend"],
  );
});

it("isOperationKind accepts the 32 kinds and nothing else, prototype names included", () => {
  for (const kind of OPERATION_KINDS) expect(isOperationKind(kind)).toBe(true);
  for (const x of [
    "__proto__",
    "constructor",
    "toString",
    "",
    "Create",
    "create ",
    7,
    null,
    undefined,
    {},
  ]) {
    expect(isOperationKind(x), String(x)).toBe(false);
  }
});

const UNTIL = new Date(APPROVAL_UNTIL);

it("the seed value of the end date is 2026-12-02 00:00 in Dhaka, and a destructive kind needs approval before it, to the millisecond", () => {
  expect(APPROVAL_UNTIL).toBe("2026-12-01T18:00:00.000Z");
  expect(requiresApproval("destroy", new Date("2026-12-01T17:59:59.999Z"), UNTIL)).toBe(true);
  expect(requiresApproval("destroy", new Date("2026-12-01T18:00:00.000Z"), UNTIL)).toBe(false);
  expect(requiresApproval("purge_snapshots", new Date("2026-11-11T00:00:00Z"), UNTIL)).toBe(true);
  expect(requiresApproval("delete_backup", new Date("2026-11-11T00:00:00Z"), UNTIL)).toBe(true);
  expect(requiresApproval("reboot", new Date("2026-11-11T00:00:00Z"), UNTIL)).toBe(false);
});

it("the end date moves with the argument: earlier, later", () => {
  const at = new Date("2026-11-20T00:00:00Z");
  expect(requiresApproval("destroy", at, UNTIL)).toBe(true);
  expect(requiresApproval("destroy", at, new Date("2026-11-15T00:00:00Z"))).toBe(false);
  expect(requiresApproval("destroy", new Date("2027-01-10T00:00:00Z"), UNTIL)).toBe(false);
  expect(
    requiresApproval("destroy", new Date("2027-01-10T00:00:00Z"), new Date("2027-01-31T00:00:00Z")),
  ).toBe(true);
});

it("a missing or invalid end date, or an invalid time, fails closed for a destructive kind (R16)", () => {
  const at = new Date("2030-01-01T00:00:00Z");
  expect(requiresApproval("destroy", at, null)).toBe(true);
  expect(requiresApproval("destroy", at, new Date(Number.NaN))).toBe(true);
  expect(requiresApproval("destroy", new Date(Number.NaN), UNTIL)).toBe(true);
  expect(requiresApproval("reboot", at, null)).toBe(false);
  expect(requiresApproval("reboot", new Date(Number.NaN), UNTIL)).toBe(false);
});

it("the states that block a younger operation of the same resource", () => {
  expect([...SIBLING_BLOCKING_STATES]).toEqual(["queued", "running", "waiting"]);
});

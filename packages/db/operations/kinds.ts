import type { OPERATION_STATES } from "../schema/provisioning";

// The seven states of operations_state_check.
export type OperationState = (typeof OPERATION_STATES)[number];

// The closed list of operation kinds. A later work package adds its kind here and in
// OPERATION_KIND_INFO; the compiler refuses a kind without info.
export const OPERATION_KINDS = [
  "create",
  "suspend",
  "resume",
  "final_snapshot",
  "destroy",
  "purge_snapshots",
  "reboot",
  "stop",
  "start",
  "rename",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
  "create_backup",
  "delete_backup",
  "set_auto_backup",
  "attach_disk",
  "detach_disk",
  "reject_operation",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

// "engine" means that no adapter runs: the provisioner does the work itself.
export type AdapterMethod =
  | "create"
  | "suspend"
  | "resume"
  | "finalSnapshot"
  | "destroy"
  | "purgeSnapshots"
  | "action"
  | "engine";

export interface KindInfo {
  readonly method: AdapterMethod;
  readonly destructive: boolean;
  // A customer may request the kind (16.10). The safe default for a new kind is false.
  readonly customerRequestable: boolean;
}

const info = (
  method: AdapterMethod,
  destructive: boolean,
  customerRequestable: boolean,
): KindInfo => ({ method, destructive, customerRequestable });

export const OPERATION_KIND_INFO: Readonly<Record<OperationKind, KindInfo>> = {
  create: info("create", false, false),
  suspend: info("suspend", false, false),
  resume: info("resume", false, false),
  final_snapshot: info("finalSnapshot", false, false),
  destroy: info("destroy", true, true),
  purge_snapshots: info("purgeSnapshots", true, false),
  reboot: info("action", false, true),
  stop: info("action", false, true),
  start: info("action", false, true),
  rename: info("action", false, true),
  set_ports: info("action", false, true),
  attach_static_ip: info("action", false, true),
  detach_static_ip: info("action", false, true),
  create_backup: info("action", false, true),
  delete_backup: info("action", true, true),
  set_auto_backup: info("action", false, true),
  attach_disk: info("action", false, true),
  detach_disk: info("action", false, true),
  reject_operation: info("engine", false, false),
};

export function isOperationKind(value: unknown): value is OperationKind {
  return typeof value === "string" && Object.hasOwn(OPERATION_KIND_INFO, value);
}

export function isDestructive(kind: OperationKind): boolean {
  return OPERATION_KIND_INFO[kind].destructive;
}

// The states that block a younger operation of the same resource.
export const SIBLING_BLOCKING_STATES = ["queued", "running", "waiting"] as const;

// The instant 2026-12-02 00:00 in Dhaka. It is the seed value of the settings row
// r13_approval_until, not a limit that code enforces.
export const APPROVAL_UNTIL = "2026-12-01T18:00:00.000Z";

// R13: a destructive kind needs admin approval before `until`. Fails closed (R16) on anything that
// cannot be compared.
export function requiresApproval(kind: OperationKind, at: Date, until: Date | null): boolean {
  if (!isDestructive(kind)) return false;
  if (until === null) return true;
  const atMs = at.getTime();
  const untilMs = until.getTime();
  if (Number.isNaN(atMs) || Number.isNaN(untilMs)) return true;
  return atMs < untilMs;
}

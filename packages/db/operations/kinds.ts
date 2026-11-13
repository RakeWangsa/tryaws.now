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
  // WP6-T4 (bucket) and WP7-T1 (container service).
  "set_bucket_access",
  "delete_access_key",
  "deploy_containers",
  "scale_container",
  // WPU-G4: one record change of a DNS zone (the record editor).
  "change_dns_record",
  // WPU-G7: load balancer, database, bucket and CDN actions of the console.
  "set_targets",
  "set_lb_attributes",
  "request_certificate",
  "refresh_certificate",
  "set_db_options",
  "set_bucket_versioning",
  // WPU-G9: open or close a bucket to one instance of the customer.
  "set_bucket_resource_access",
  "reset_cache",
  // WPU-G8: container service and CDN. A plan change is scheduled by the customer and applied by the
  // lifecycle at the next renewal (no proration in a prepaid term); the two apply kinds are never
  // requested by a customer.
  "schedule_plan_change",
  "change_cdn_bundle",
  "set_cache_behaviors",
  "set_cdn_origin",
  // WPA-P2: an admin clears the failure mark of a plan change (audited, reason required). No AWS call:
  // the adapter only patches the config. Never requested by a customer.
  "clear_plan_change_mark",
  // WPU-G11: take a certificate off a resource and delete it, or replace it by one for new domains;
  // the parameters of a database (set the whitelisted ones, read the list again).
  "remove_certificate",
  "replace_certificate",
  "set_db_parameters",
  "read_db_parameters",
  // WPU-B2: the domain actions. `renew_domain` is enqueued by the lifecycle only (money; the renewal price rule
  // is open); the other two change no money and delete nothing.
  "renew_domain",
  "resend_verification",
  "set_name_servers",
  "reject_operation",
  // WPU-B3 (10.1): the removal of what a failed create already made in AWS. Queued by the automatic
  // reversal, never requested by a customer. It runs the destroy method of the adapter (a name that
  // is not found is success), but the guard asks for a failed resource with an ended subscription
  // instead of a final snapshot: nothing of the customer's was ever there. Destructive: admin approval
  // until the end date of R13.
  "cleanup_failed_create",
  // WPU-X3 (b): an admin (finance or superadmin) asks for a fresh registry check of a domain renewal stuck in
  // needs_attention at `poll`. The provisioner reads the registry and, only on a final "not renewed" with the expiry
  // unchanged, moves the renewal to failed with its refund (functions/provisioner/confirm-unrenewed.ts). Never
  // requested by a customer; changes no AWS resource.
  "confirm_unrenewed",
] as const;

export type OperationKind = (typeof OPERATION_KINDS)[number];

// "engine" means that no adapter runs: the provisioner does the work itself (reject_operation; confirm_unrenewed,
// which reads the registry through its own port).
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
  set_bucket_access: info("action", false, true),
  delete_access_key: info("action", false, true),
  deploy_containers: info("action", false, true),
  // Applies a new power and scale at once: only the lifecycle at a renewal enqueues it (WPU-G8).
  scale_container: info("action", false, false),
  change_dns_record: info("action", false, true),
  set_targets: info("action", false, true),
  set_lb_attributes: info("action", false, true),
  request_certificate: info("action", false, true),
  refresh_certificate: info("action", false, true),
  set_db_options: info("action", false, true),
  set_bucket_versioning: info("action", false, true),
  set_bucket_resource_access: info("action", false, true),
  reset_cache: info("action", false, true),
  schedule_plan_change: info("action", false, true),
  change_cdn_bundle: info("action", false, false),
  set_cache_behaviors: info("action", false, true),
  set_cdn_origin: info("action", false, true),
  clear_plan_change_mark: info("action", false, false),
  // No resource and no data is destroyed (a certificate is free and is requested again at will), so
  // there is no admin approval; the web tier asks a fresh sign-in and the typed domain (U10).
  remove_certificate: info("action", false, true),
  replace_certificate: info("action", false, true),
  set_db_parameters: info("action", false, true),
  read_db_parameters: info("action", false, true),
  renew_domain: info("action", false, false),
  resend_verification: info("action", false, true),
  set_name_servers: info("action", false, true),
  reject_operation: info("engine", false, false),
  cleanup_failed_create: info("destroy", true, false),
  // Run by the engine like reject_operation: it reads the registry (no adapter call) and writes the database.
  confirm_unrenewed: info("engine", false, false),
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

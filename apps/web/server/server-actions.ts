import type { CustomerSession } from "@tc/auth";
import {
  addFirewallRule,
  currentFirewallRules,
  firewallRuleKey,
  parseNewFirewallRule,
  parseServerDisplayName,
  removeFirewallRule,
} from "@tc/core";
import type { OperationKind } from "@tc/core";
import type {
  AuditRepo,
  CustomerLimit,
  OperationsRepo,
  RateLimitsRepo,
  ResourceSummary,
  ResourcesRepo,
} from "@tc/db";

// The cores of the Server Actions of a server's header and Networking tab (WPU-G2): reboot, stop,
// start, rename, the firewall rules and the static IP. R9 order in each: authenticate, authorize (the
// ownership of the server and the flag of its family, R8 and R12), validate, rate limit, execute,
// audit. Every action is an operation row (R1: nothing here calls AWS) and is idempotent by the
// request id that the page put in the form (R7). The ports are parameters, so the cores run in a test
// without a database. What leaves a core is a fixed public key, never the text of an error (U6, R14).
// None of these actions is destructive in the sense of U10 (the kinds are not marked destructive);
// detaching the static IP asks for an explicit acknowledgement because the address changes.

export interface ServerOpsRepos {
  resources: ResourcesRepo;
  operations: OperationsRepo;
  audit: AuditRepo;
  rateLimits: RateLimitsRepo;
  /** R12, R16: the flag of the family for the customer's market; false when it cannot be read. */
  familyOn(family: string): Promise<boolean>;
}

export interface ServerOpsDeps {
  authenticate(): Promise<CustomerSession | null>;
  now(): Date;
  /** One transaction of the customer's own repositories (R8: the id comes from the session). */
  store<T>(customerId: string, fn: (repos: ServerOpsRepos) => Promise<T>): Promise<T>;
}

export type ServerOpsError =
  | "unauthenticated"
  | "flag_off"
  | "validation"
  | "rate_limited"
  | "not_found"
  | "not_allowed"
  | "busy"
  | "duplicate"
  | "too_many"
  | "unavailable";

export type ServerOpsResult =
  | { ok: true; done: string }
  | { ok: false; error: ServerOpsError; fields?: Record<string, string> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE_FAMILIES = ["linux_instance", "windows_instance"];
const RULE_KEY = /^(?:tcp|udp|icmp):-?\d{1,5}--?\d{1,5}$/;

const limit = (action: string, count: number, windowSeconds: number): CustomerLimit[] => [
  Object.freeze({ action, limit: count, windowSeconds }),
];
const POWER_LIMIT = limit("server.power", 20, 3600);
const WRITE_LIMIT = limit("server.settings", 60, 3600);

// An operation that is still to run or running blocks another of the kinds that change the same
// thing: two firewall edits made from the same list would overwrite each other.
const IN_FLIGHT = ["queued", "running", "waiting", "needs_approval"];
const CONFLICTING: readonly OperationKind[] = [
  "reboot",
  "stop",
  "start",
  "set_ports",
  "attach_static_ip",
  "detach_static_ip",
];

class Refusal extends Error {
  constructor(
    readonly error: ServerOpsError,
    readonly fields?: Record<string, string>,
  ) {
    super(error);
  }
}

const fail = (error: ServerOpsError, fields?: Record<string, string>): ServerOpsResult => ({
  ok: false,
  error,
  ...(fields ? { fields } : {}),
});

const record = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

function uuid(input: Record<string, unknown>, key: string, bad: Record<string, string>): string {
  const v = input[key];
  if (typeof v === "string" && UUID.test(v)) return v;
  bad[key] = "invalid";
  return "";
}

const text = (input: Record<string, unknown>, key: string): string => {
  const v = input[key];
  return typeof v === "string" ? v : "";
};

interface Plan {
  limits: readonly CustomerLimit[];
  action: string;
  kind: OperationKind;
  /** The server must be in one of these states. */
  states: readonly string[];
  /** Runs inside the transaction with the customer's own row; throws a Refusal. */
  prepare(server: ResourceSummary): {
    payload?: Record<string, unknown>;
    /** Added to the idempotency key when one request id may carry different payloads. */
    keySuffix?: string;
    done: string;
  };
}

async function run(
  deps: ServerOpsDeps,
  raw: unknown,
  build: (bad: Record<string, string>, input: Record<string, unknown>) => Plan,
): Promise<ServerOpsResult> {
  const session = await deps.authenticate();
  if (session === null) return fail("unauthenticated");
  const input = record(raw);
  const bad: Record<string, string> = {};
  const serverId = uuid(input, "serverId", bad);
  const requestId = uuid(input, "requestId", bad);
  const plan = build(bad, input);
  if (Object.keys(bad).length > 0) return fail("validation", bad);
  try {
    return await deps.store(session.customerId, async (repos) => {
      const server = await repos.resources.get(serverId);
      if (server === null || !INSTANCE_FAMILIES.includes(server.family)) {
        throw new Refusal("not_found");
      }
      if (!(await repos.familyOn(server.family))) throw new Refusal("flag_off");
      const decision = await repos.rateLimits.consume(plan.limits, deps.now());
      if (!decision.allowed) return fail("rate_limited");
      if (!plan.states.includes(server.state)) throw new Refusal("not_allowed");
      const step = plan.prepare(server);
      const written = await repos.operations.request({
        resourceId: serverId,
        kind: plan.kind,
        idempotencyKey: `${plan.action}:${requestId}${step.keySuffix ? `:${step.keySuffix}` : ""}`,
        ...(step.payload ? { payload: step.payload } : {}),
      });
      if (!written.ok) {
        throw new Refusal(written.error === "not_found" ? "not_found" : "unavailable");
      }
      if (!written.replayed && CONFLICTING.includes(plan.kind)) {
        // The row was just written: if another of the kinds is on its way, this transaction is
        // rolled back by the refusal and nothing is queued.
        const others = await repos.operations.listForResource(serverId);
        const busy = others.some(
          (o) =>
            o.id !== written.value.id &&
            IN_FLIGHT.includes(o.state) &&
            CONFLICTING.includes(o.kind as OperationKind),
        );
        if (busy) throw new Refusal("busy");
      }
      const audited = await repos.audit.record({
        action: `server.${plan.action}`,
        targetType: "resource",
        targetId: serverId,
      });
      // The audit entry is part of the action: without it everything rolls back (R9, R16).
      if (!audited.ok) throw new Error("server-actions: the audit entry was refused");
      return { ok: true, done: step.done } satisfies ServerOpsResult;
    });
  } catch (error) {
    return error instanceof Refusal ? fail(error.error, error.fields) : fail("unavailable");
  }
}

// ----- Power -----------------------------------------------------------------------------------

const power = (kind: "reboot" | "stop" | "start", states: readonly string[], done: string) =>
  function core(deps: ServerOpsDeps, raw: unknown): Promise<ServerOpsResult> {
    return run(deps, raw, () => ({
      limits: POWER_LIMIT,
      action: kind,
      kind,
      states,
      prepare: () => ({ done }),
    }));
  };

/** 16.10 Overview: `rebootServer`. A running server only. */
export const rebootServerCore = power("reboot", ["active"], "rebooting");
/** 16.10 Overview: `stopServer`. Stopping does not stop the billing of the plan; the screen says so. */
export const stopServerCore = power("stop", ["active"], "stopping");
/** 16.10 Overview: `startServer`. A stopped server only (a suspended one belongs to the lifecycle). */
export const startServerCore = power("start", ["stopped"], "starting");

// ----- Rename ----------------------------------------------------------------------------------

/**
 * 16.10 Overview: `renameServer`. The name is the customer's own label in our database; the AWS name
 * is generated and never changes (R11). The same name rule as the create form.
 */
export function renameServerCore(deps: ServerOpsDeps, raw: unknown): Promise<ServerOpsResult> {
  return run(deps, raw, (bad, input) => {
    const name = parseServerDisplayName(input["displayName"]);
    if (name === null) bad["displayName"] = "invalid";
    return {
      limits: WRITE_LIMIT,
      action: "rename",
      kind: "rename",
      states: ["active", "stopped", "suspended"],
      prepare: () => ({ payload: { displayName: name }, done: "renamed" }),
    };
  });
}

// ----- Firewall --------------------------------------------------------------------------------

const FIREWALL_STATES = ["active", "stopped"];

function rulesOf(server: ResourceSummary) {
  const rules = currentFirewallRules(server.config, server.family);
  // A saved list that cannot be read is never edited blindly (R16).
  if (rules === null) throw new Refusal("unavailable");
  return rules;
}

/**
 * 16.10 Networking: `saveFirewallRules`, add one rule. The new list is the stored list plus the rule,
 * computed here from the customer's own row; the page's copy of the list is never trusted. IPv4 only.
 */
export function addFirewallRuleCore(deps: ServerOpsDeps, raw: unknown): Promise<ServerOpsResult> {
  return run(deps, raw, (bad, input) => {
    const parsed = parseNewFirewallRule({
      preset: input["preset"],
      protocol: input["protocol"],
      fromPort: input["fromPort"],
      toPort: input["toPort"],
      sources: text(input, "sourceMode") === "restrict" ? input["sources"] : "any",
    });
    if (!parsed.ok) Object.assign(bad, parsed.fields);
    return {
      limits: WRITE_LIMIT,
      action: "firewall_add",
      kind: "set_ports",
      states: FIREWALL_STATES,
      prepare: (server) => {
        if (!parsed.ok) throw new Refusal("validation");
        const next = addFirewallRule(rulesOf(server), parsed.rule);
        if (!next.ok) throw new Refusal(next.error === "duplicate" ? "duplicate" : "too_many");
        return {
          payload: { ports: next.rules },
          keySuffix: firewallRuleKey(parsed.rule),
          done: "firewallSaved",
        };
      },
    };
  });
}

/** 16.10 Networking: `saveFirewallRules`, remove one rule by its key (protocol and port range). */
export function removeFirewallRuleCore(
  deps: ServerOpsDeps,
  raw: unknown,
): Promise<ServerOpsResult> {
  return run(deps, raw, (bad, input) => {
    const key = text(input, "ruleKey");
    if (!RULE_KEY.test(key)) bad["ruleKey"] = "invalid";
    return {
      limits: WRITE_LIMIT,
      action: "firewall_remove",
      kind: "set_ports",
      states: FIREWALL_STATES,
      prepare: (server) => {
        const next = removeFirewallRule(rulesOf(server), key);
        if (!next.ok) throw new Refusal("not_found");
        return {
          payload: { ports: next.rules },
          keySuffix: key,
          done: "firewallSaved",
        };
      },
    };
  });
}

// ----- Static IP -------------------------------------------------------------------------------

const attachedOf = (server: ResourceSummary): boolean => {
  const c = record(server.config);
  // A server is created with its static IP attached; only a detach turns it off.
  return c["staticIpAttached"] !== false;
};

/** 16.10 Networking: `attachStaticIp`. Puts the server's own static IP back after a detach. */
export function attachStaticIpCore(deps: ServerOpsDeps, raw: unknown): Promise<ServerOpsResult> {
  return run(deps, raw, () => ({
    limits: WRITE_LIMIT,
    action: "static_ip_attach",
    kind: "attach_static_ip",
    states: FIREWALL_STATES,
    prepare: (server) => {
      if (attachedOf(server)) throw new Refusal("not_allowed");
      return { done: "staticIpAttaching" };
    },
  }));
}

/**
 * 16.10 Networking: `detachStaticIp`. The server gets an address of its own that changes when it is
 * stopped, so the customer must say they know (a typed name is not required: nothing is deleted).
 */
export function detachStaticIpCore(deps: ServerOpsDeps, raw: unknown): Promise<ServerOpsResult> {
  return run(deps, raw, (bad, input) => {
    const ack = input["acknowledge"];
    if (ack !== "on" && ack !== "true") bad["acknowledge"] = "required";
    return {
      limits: WRITE_LIMIT,
      action: "static_ip_detach",
      kind: "detach_static_ip",
      states: FIREWALL_STATES,
      prepare: (server) => {
        if (!attachedOf(server)) throw new Refusal("not_allowed");
        return { done: "staticIpDetaching" };
      },
    };
  });
}

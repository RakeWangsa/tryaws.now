import { nextDomainState, type DomainEvent, type DomainState } from "./state";

// WPU-B2: which status and facts the `domains` row gets when an operation of the domain ends. Pure: the
// provisioner hook reads the row and the resource config, asks this function, and writes the answer with a
// compare-and-set on the status it read. Every move goes through the state machine (state.ts); a move that
// the table does not know is `null`, and so is a fact that cannot be trusted (R16). The config is written
// by the adapter but is read as untrusted data, field by field.

export interface DomainPlan {
  readonly to: DomainState;
  readonly expiresAt?: Date;
  readonly hostedZoneId?: string;
  readonly route53OperationId?: string;
}

const ZONE = /^[A-Z0-9]{1,32}$/;
const OPERATION = /^[A-Za-z0-9-]{1,128}$/;

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function dateOf(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? undefined : date;
}

/** Walks the events from `from`; null as soon as one move is not in the table. */
function walk(from: string, events: readonly DomainEvent[]): DomainState | null {
  let state: string = from;
  for (const event of events) {
    const next = nextDomainState(state, event);
    if (next === null) return null;
    state = next;
  }
  return state as DomainState;
}

export function planDomainSync(
  current: string,
  kind: string,
  outcome: "succeeded" | "failed",
  resourceConfig: unknown,
): DomainPlan | null {
  const config = recordOf(resourceConfig);
  if (outcome !== "succeeded" && outcome !== "failed") return null;

  if (kind === "create") {
    // A create that ran was approved: a review row becomes pending first.
    const approved: readonly DomainEvent[] = current === "review" ? ["approved"] : [];
    if (outcome === "failed") {
      // A row past the registration is never downgraded by a late failure.
      if (current !== "pending" && current !== "review") return null;
      const to = walk(current, [...approved, "registration_failed"]);
      return to === null ? null : { to };
    }
    const verified = config["domainStatus"] === "registered";
    const events: DomainEvent[] =
      current === "awaiting_verification"
        ? verified
          ? ["contact_verified"]
          : []
        : ["registration_succeeded", ...(verified ? (["contact_verified"] as const) : [])];
    if (events.length === 0) return null;
    const to = walk(current, [...approved, ...events]);
    if (to === null) return null;
    const expiresAt = dateOf(config["expiresAt"]);
    const zone = config["hostedZoneId"];
    const operation = config["route53OperationId"];
    return {
      to,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(typeof zone === "string" && ZONE.test(zone) ? { hostedZoneId: zone } : {}),
      ...(typeof operation === "string" && OPERATION.test(operation)
        ? { route53OperationId: operation }
        : {}),
    };
  }

  if (kind === "renew_domain") {
    if (outcome !== "succeeded") return null;
    const expiresAt = dateOf(config["expiresAt"]);
    if (expiresAt === undefined) return null;
    const to = walk(current, ["renewed"]);
    return to === null ? null : { to, expiresAt };
  }

  if (kind === "resend_verification") {
    // Only the registry's own "done" moves a domain to registered.
    if (outcome !== "succeeded" || config["reachability"] !== "done") return null;
    if (current !== "awaiting_verification") return null;
    const to = walk(current, ["contact_verified"]);
    return to === null ? null : { to };
  }

  return null;
}

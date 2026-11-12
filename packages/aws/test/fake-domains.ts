import type { RegistrantContact } from "@tc/core";
import { AwsError } from "../errors";
import type { TldPrice } from "../catalog";
import type {
  ContactReachability,
  DomainAvailability,
  DomainDetail,
  DomainOperationStatus,
  DomainsPort,
} from "../adapters/domains-port";
import type { Route53Port } from "../adapters/route53-port";

interface FakeOperation {
  readonly id: string;
  readonly name: string;
  readonly kind: "register" | "renew";
  readonly years: number;
  status: DomainOperationStatus;
  polls: number;
}

interface FakeDomain {
  name: string;
  expiresAt: Date;
  reachability: ContactReachability;
  nameServers: string[];
}

export interface FakeDomainsOptions {
  /** The fake Route 53 of the same account: a finished registration makes the hosted zone there. */
  readonly route53?: Route53Port;
  readonly now?: () => Date;
  readonly prices?: readonly TldPrice[];
  /** The number of polls before an operation finishes by itself; undefined: only `finish` ends it. */
  readonly finishAfterPolls?: number;
}

/**
 * An in-memory Route 53 Domains for tests. Names in `unavailable` and `premium` answer that way;
 * RegisterDomain of a name that is registered or in progress is a `conflict` (DuplicateRequest).
 */
export function createFakeDomains(options: FakeDomainsOptions = {}) {
  const now = options.now ?? (() => new Date("2030-01-01T00:00:00.000Z"));
  const unavailable = new Set<string>();
  const premium = new Set<string>();
  const domains = new Map<string, FakeDomain>();
  const operations = new Map<string, FakeOperation>();
  const calls: { op: string; name?: string }[] = [];
  const contacts = new Map<string, RegistrantContact>();
  let next = 1;

  async function finishOperation(op: FakeOperation, status: DomainOperationStatus): Promise<void> {
    op.status = status;
    if (status !== "successful") return;
    const current = domains.get(op.name);
    if (op.kind === "register") {
      const expiresAt = new Date(now().getTime());
      expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + op.years);
      // RegisterDomain makes the hosted zone with the domain's name (spec 12) and points the name
      // servers of the domain to it.
      const made = await options.route53?.createHostedZone({
        name: op.name,
        callerReference: `fake-register:${op.id}`,
        comment: "fake registration zone",
      });
      domains.set(op.name, {
        name: op.name,
        expiresAt,
        reachability: "pending",
        nameServers: made?.zone.nameServers.map((n) => n.replace(/\.$/, "")) ?? [
          "ns-1.fake-dns.example",
        ],
      });
    } else if (current !== undefined) {
      const expiresAt = new Date(current.expiresAt.getTime());
      expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + op.years);
      current.expiresAt = expiresAt;
    }
  }

  const port: DomainsPort = {
    async checkAvailability(name): Promise<DomainAvailability> {
      calls.push({ op: "checkAvailability", name });
      if (premium.has(name)) return "premium";
      if (unavailable.has(name) || domains.has(name)) return "unavailable";
      for (const op of operations.values()) {
        if (op.name === name && op.kind === "register" && op.status === "in_progress") {
          return "unavailable";
        }
      }
      return "available";
    },
    async listPrices(): Promise<readonly TldPrice[]> {
      calls.push({ op: "listPrices" });
      return options.prices ?? [];
    },
    async registerDomain(input) {
      calls.push({ op: "registerDomain", name: input.name });
      for (const op of operations.values()) {
        if (op.name === input.name && op.kind === "register" && op.status === "in_progress") {
          throw new AwsError({ code: "conflict", retryable: true });
        }
      }
      if (domains.has(input.name) || unavailable.has(input.name)) {
        throw new AwsError({ code: "conflict", retryable: false });
      }
      const id = `fake-op-${String(next++).padStart(4, "0")}`;
      operations.set(id, {
        id,
        name: input.name,
        kind: "register",
        years: input.years,
        status: "in_progress",
        polls: 0,
      });
      contacts.set(id, input.contact);
      return { operationId: id };
    },
    async getOperationDetail(operationId) {
      calls.push({ op: "getOperationDetail" });
      const op = operations.get(operationId);
      if (op === undefined) throw new AwsError({ code: "not_found", retryable: false });
      op.polls += 1;
      if (
        op.status === "in_progress" &&
        options.finishAfterPolls !== undefined &&
        op.polls >= options.finishAfterPolls
      ) {
        await finishOperation(op, "successful");
      }
      return { status: op.status };
    },
    async renewDomain(input) {
      calls.push({ op: "renewDomain", name: input.name });
      const current = domains.get(input.name);
      if (current === undefined) throw new AwsError({ code: "not_found", retryable: false });
      if (current.expiresAt.getUTCFullYear() !== input.currentExpiryYear) {
        throw new AwsError({ code: "conflict", retryable: false });
      }
      const id = `fake-op-${String(next++).padStart(4, "0")}`;
      const op: FakeOperation = {
        id,
        name: input.name,
        kind: "renew",
        years: input.years,
        status: "in_progress",
        polls: 0,
      };
      operations.set(id, op);
      return { operationId: id };
    },
    async getDomainDetail(name): Promise<DomainDetail | null> {
      calls.push({ op: "getDomainDetail", name });
      const found = domains.get(name);
      if (found === undefined) return null;
      return {
        name: found.name,
        expiresAt: found.expiresAt,
        nameServers: found.nameServers,
        reachability: found.reachability,
      };
    },
    async resendContactReachabilityEmail(name) {
      calls.push({ op: "resendContactReachabilityEmail", name });
      if (!domains.has(name)) throw new AwsError({ code: "not_found", retryable: false });
    },
  };

  return {
    port,
    calls,
    domains,
    operations,
    unavailable,
    premium,
    /** The contact that RegisterDomain received for an operation; tests only. */
    contactOf: (operationId: string) => contacts.get(operationId),
    /** Ends an operation the way the registry would. */
    finish: async (operationId: string, status: DomainOperationStatus) => {
      const op = operations.get(operationId);
      if (op === undefined) throw new Error("fake-domains: no such operation");
      await finishOperation(op, status);
    },
    verifyContact: (name: string) => {
      const found = domains.get(name);
      if (found !== undefined) found.reachability = "done";
    },
  };
}

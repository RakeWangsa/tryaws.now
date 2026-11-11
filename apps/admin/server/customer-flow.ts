import type { AdminActor, AdminRepos, CustomerChanged, KycDecided, RiskTier } from "@tc/db";

// The five decisions on /customers/[id] in the order of R9: authenticate and authorize (the roles
// ops and superadmin), validate, rate limit, execute (one transaction, every write through `audited`,
// which appends the audit row with actor, reason, IP and target), and the answer. No next/* import
// here: the Server Actions in customer-actions.ts wire the real pieces, so every step is tested with
// fakes. Answers are fixed codes, never the text of an error (R14, R16).

export type CustomerActionKind = "approveKyc" | "rejectKyc" | "setRiskTier" | "suspend" | "resume";

export interface CustomerActionRequest {
  readonly kind: CustomerActionKind;
  // The submission id for the two KYC decisions, the customer id for the others.
  readonly id: unknown;
  readonly reason: unknown;
  readonly note?: unknown;
  readonly tier?: unknown;
}

export type CustomerActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type CustomerActionAnswer =
  | { readonly ok: true; readonly replayed: boolean; readonly customerId: string }
  | { readonly ok: false; readonly code: CustomerActionCode };

export interface CustomerFlowDeps {
  // requireAdmin(["ops", "superadmin"]): rejects when there is no admin session or the role is wrong.
  readonly authorize: () => Promise<AdminActor>;
  // True when the hit was counted, false over the limit.
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  // One transaction as admin_rw with the repositories of the actor.
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  readonly clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEXT = 500;
const TIERS: readonly RiskTier[] = ["new", "trusted"];
const KINDS: readonly CustomerActionKind[] = [
  "approveKyc",
  "rejectKyc",
  "setRiskTier",
  "suspend",
  "resume",
];

interface Valid {
  readonly kind: CustomerActionKind;
  readonly id: string;
  readonly reason: string;
  readonly note: string | undefined;
  readonly tier: RiskTier | undefined;
}

function validate(request: CustomerActionRequest): Valid | null {
  const { kind, id, reason, note, tier } = request;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof reason !== "string") return null;
  const cleanReason = reason.trim();
  if (cleanReason === "" || cleanReason.length > MAX_TEXT) return null;
  let cleanNote: string | undefined;
  if (note !== undefined && note !== null && note !== "") {
    if (typeof note !== "string" || note.length > MAX_TEXT) return null;
    cleanNote = note.trim() === "" ? undefined : note.trim();
  }
  let cleanTier: RiskTier | undefined;
  if (kind === "setRiskTier") {
    if (typeof tier !== "string" || !TIERS.includes(tier as RiskTier)) return null;
    cleanTier = tier as RiskTier;
  }
  return { kind, id, reason: cleanReason, note: cleanNote, tier: cleanTier };
}

type Outcome =
  | { ok: true; value: KycDecided | CustomerChanged; replayed: boolean }
  | { ok: false; error: "not_found" | "conflict" | "validation" | "forbidden" };

export function makeCustomerAction(
  deps: CustomerFlowDeps,
): (request: CustomerActionRequest) => Promise<CustomerActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const snapshot: CustomerActionRequest = {
      kind: request.kind,
      id: request.id,
      reason: request.reason,
      note: request.note,
      tier: request.tier,
    };
    // 1 and 2. Authenticate and authorize.
    let actor: AdminActor;
    try {
      actor = await deps.authorize();
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      // 3. Validate.
      const input = validate(snapshot);
      if (input === null) return { ok: false, code: "invalid" };
      const at = deps.clock.now();
      // 4. Rate limit.
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      // 5 and 6. Execute and audit, in one transaction.
      const outcome = await deps.run<Outcome>(actor, (repos) => {
        switch (input.kind) {
          case "approveKyc":
            return repos.customers.approveKyc(
              { submissionId: input.id, at, ...(input.note ? { note: input.note } : {}) },
              input.reason,
            );
          case "rejectKyc":
            return repos.customers.rejectKyc(
              { submissionId: input.id, at, ...(input.note ? { note: input.note } : {}) },
              input.reason,
            );
          case "setRiskTier":
            return repos.customers.setRiskTier(
              { customerId: input.id, tier: input.tier as RiskTier },
              input.reason,
            );
          case "suspend":
            return repos.customers.suspend({ customerId: input.id, at }, input.reason);
          case "resume":
            return repos.customers.resume({ customerId: input.id, at }, input.reason);
        }
      });
      if (!outcome.ok) {
        if (outcome.error === "forbidden") return { ok: false, code: "denied" };
        if (outcome.error === "validation") return { ok: false, code: "invalid" };
        return { ok: false, code: outcome.error };
      }
      return { ok: true, replayed: outcome.replayed, customerId: outcome.value.customerId };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}

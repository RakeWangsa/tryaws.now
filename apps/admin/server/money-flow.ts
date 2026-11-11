import type { AdminActor, AdminRepos, AdminRole, LedgerPoster } from "@tc/db";

// The money actions of /wallets/[customerId] and /payments in the order of R9: authenticate and
// authorize (the roles of each kind), validate, rate limit, execute (one transaction, every write
// through `audited`, which appends the audit row with actor, reason, IP and target), and the answer.
// No next/* import here: the Server Action in money-actions.ts wires the real pieces, so every step
// is tested with fakes. A wallet is never credited from here except as an ADJUSTMENT posting by the
// repository (R6 stays with the verified EPS path); `reverifyPayment` only sends a payment back to the
// sweeper. Answers are fixed codes, never the text of an error (R14, R16).

export type MoneyActionKind =
  | "createAdjustment"
  | "approveAdjustment"
  | "rejectAdjustment"
  | "reverifyPayment"
  | "recordManualRefund"
  | "resolveDiscrepancy";

export interface MoneyActionRequest {
  readonly kind: MoneyActionKind;
  // createAdjustment: the request id made when the form was rendered (R7). approve and reject: the
  // adjustment. reverify and refund: the payment. resolve: the discrepancy.
  readonly id: unknown;
  readonly reason: unknown;
  readonly customerId?: unknown;
  readonly direction?: unknown;
  // Taka as text, for example "1500.50"; never a number (R4).
  readonly amount?: unknown;
  readonly adjustmentKind?: unknown;
  readonly evidence?: unknown;
}

export type MoneyActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type MoneyActionAnswer =
  | {
      readonly ok: true;
      readonly replayed: boolean;
      readonly targetId: string;
      readonly customerId: string | null;
      readonly status?: string;
    }
  | { readonly ok: false; readonly code: MoneyActionCode };

export interface MoneyFlowDeps {
  // requireAdmin(roles): rejects when there is no admin session or the role is not in the list.
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  // True when the hit was counted, false over the limit.
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  // One transaction as admin_rw with the repositories of the actor.
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos) => Promise<T>) => Promise<T>;
  // postTransaction of @tc/core (R5): the repositories post through it.
  readonly post: LedgerPoster;
  readonly clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_TEXT = 500;
const MAX_EVIDENCE = 200;

// 16.12: finance creates; a second finance or superadmin decides; finance re-verifies and refunds; ops
// and finance resolve a discrepancy (superadmin owns every area).
export const KIND_ROLES: Readonly<Record<MoneyActionKind, readonly AdminRole[]>> = {
  createAdjustment: ["finance"],
  approveAdjustment: ["finance", "superadmin"],
  rejectAdjustment: ["finance", "superadmin"],
  reverifyPayment: ["finance"],
  recordManualRefund: ["finance"],
  resolveDiscrepancy: ["ops", "finance", "superadmin"],
};
const KINDS = Object.keys(KIND_ROLES) as MoneyActionKind[];
const DIRECTIONS = ["credit", "debit"] as const;
const ADJUSTMENT_KINDS = ["goodwill", "deposit", "correction"] as const;

// Taka text to paisa with integer arithmetic only: one to fifteen whole digits and at most two
// decimals, above zero. No Number() anywhere near money (R4).
export function parseTaka(text: unknown): bigint | null {
  if (typeof text !== "string") return null;
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (match === null) return null;
  const whole = BigInt(match[1] as string);
  const paisa = BigInt(((match[2] ?? "") + "00").slice(0, 2));
  const minor = whole * 100n + paisa;
  return minor > 0n ? minor : null;
}

interface Valid {
  readonly kind: MoneyActionKind;
  readonly id: string;
  readonly reason: string;
  readonly customerId: string | null;
  readonly direction: (typeof DIRECTIONS)[number] | null;
  readonly amountMinor: bigint | null;
  readonly adjustmentKind: (typeof ADJUSTMENT_KINDS)[number] | null;
  readonly evidence: string | undefined;
}

function validate(request: MoneyActionRequest): Valid | null {
  const { kind, id, reason, customerId, direction, amount, adjustmentKind, evidence } = request;
  if (typeof kind !== "string" || !KINDS.includes(kind)) return null;
  if (typeof id !== "string" || !UUID.test(id)) return null;
  if (typeof reason !== "string") return null;
  const cleanReason = reason.trim();
  if (cleanReason === "" || cleanReason.length > MAX_TEXT) return null;
  const out = {
    kind,
    id: id.toLowerCase(),
    reason: cleanReason,
    customerId: null as string | null,
    direction: null as Valid["direction"],
    amountMinor: null as bigint | null,
    adjustmentKind: null as Valid["adjustmentKind"],
    evidence: undefined as string | undefined,
  };
  if (kind === "createAdjustment") {
    if (typeof customerId !== "string" || !UUID.test(customerId)) return null;
    out.customerId = customerId.toLowerCase();
    if (typeof direction !== "string" || !(DIRECTIONS as readonly string[]).includes(direction)) {
      return null;
    }
    out.direction = direction as Valid["direction"];
    if (
      typeof adjustmentKind !== "string" ||
      !(ADJUSTMENT_KINDS as readonly string[]).includes(adjustmentKind)
    ) {
      return null;
    }
    out.adjustmentKind = adjustmentKind as Valid["adjustmentKind"];
    if (evidence !== undefined && evidence !== null && evidence !== "") {
      if (typeof evidence !== "string" || evidence.length > MAX_EVIDENCE) return null;
      out.evidence = evidence.trim() === "" ? undefined : evidence.trim();
    }
  }
  if (kind === "createAdjustment" || kind === "recordManualRefund") {
    out.amountMinor = parseTaka(amount);
    if (out.amountMinor === null) return null;
  }
  return out;
}

type Outcome =
  | { ok: true; value: { customerId?: string; status?: string }; replayed: boolean }
  | { ok: false; error: "not_found" | "conflict" | "validation" | "forbidden" };

export function makeMoneyAction(
  deps: MoneyFlowDeps,
): (request: MoneyActionRequest) => Promise<MoneyActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const snapshot: MoneyActionRequest = {
      kind: request.kind,
      id: request.id,
      reason: request.reason,
      customerId: request.customerId,
      direction: request.direction,
      amount: request.amount,
      adjustmentKind: request.adjustmentKind,
      evidence: request.evidence,
    };
    // 1 and 2. Authenticate and authorize, with the roles of the kind. An unknown kind is refused
    // with the narrowest list.
    const known = typeof snapshot.kind === "string" && KINDS.includes(snapshot.kind);
    let actor: AdminActor;
    try {
      actor = await deps.authorize(known ? KIND_ROLES[snapshot.kind] : KIND_ROLES.createAdjustment);
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
          case "createAdjustment":
            return repos.wallets.createAdjustment(
              {
                requestId: input.id,
                at,
                customerId: input.customerId as string,
                direction: input.direction as "credit" | "debit",
                amountMinor: input.amountMinor as bigint,
                kind: input.adjustmentKind as "goodwill",
                ...(input.evidence === undefined ? {} : { evidenceRef: input.evidence }),
              },
              input.reason,
              deps.post,
            );
          case "approveAdjustment":
            return repos.wallets.approveAdjustment({ id: input.id }, input.reason, deps.post);
          case "rejectAdjustment":
            return repos.wallets.rejectAdjustment({ id: input.id }, input.reason);
          case "reverifyPayment":
            return repos.payments.reverify({ paymentId: input.id }, input.reason);
          case "recordManualRefund":
            return repos.payments.recordManualRefund(
              { paymentId: input.id, amountMinor: input.amountMinor as bigint },
              input.reason,
              deps.post,
            );
          case "resolveDiscrepancy":
            return repos.payments.resolveDiscrepancy({ id: input.id }, input.reason);
        }
      });
      if (!outcome.ok) {
        if (outcome.error === "forbidden") return { ok: false, code: "denied" };
        if (outcome.error === "validation") return { ok: false, code: "invalid" };
        return { ok: false, code: outcome.error };
      }
      const { customerId, status } = outcome.value;
      return {
        ok: true,
        replayed: outcome.replayed,
        targetId: input.id,
        customerId: typeof customerId === "string" ? customerId : null,
        ...(typeof status === "string" ? { status } : {}),
      };
    } catch {
      // Fail closed (R16): a database or limiter error is not a success and tells nothing.
      return { ok: false, code: "unavailable" };
    }
  };
}

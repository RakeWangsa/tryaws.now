import { isMarket } from "./schemas.ts";
import { sellerFieldErrors } from "@tc/core";
import type { AdminActor, AdminRole, SellerRow, Tx } from "@tc/db";
import {
  PRICING_ROLES,
  fail,
  readReason,
  repoRefusal,
  type Authorized,
  type FlowAnswer,
  type PricingFlowDeps,
} from "./pricing-flow.ts";

// The action of /pricing/seller (WPU-I1): the legal details of the seller on the tax invoices (Mushak 6.3).
// In the order of R9: authenticate and authorize (finance and superadmin, the roles of the pricing area),
// validate, rate limit, execute in one transaction (the repository write stores actor, reason, IP and
// target through `audited`, R10, with the before and after values), and a fixed answer. No next/* import.
// Answers are fixed codes and the NAMES of fields, never a value (R14, R16). Nothing is seeded or
// defaulted here: the owner types the values.

const OPTIONAL = ["vatCircle", "tradeLicense", "phone", "email"] as const;
const REQUIRED = [
  "legalNameBn",
  "legalNameEn",
  "bin",
  "addressBn",
  "addressEn",
  "signatoryName",
  "signatoryDesignation",
] as const;

export interface SaveInvoiceSellerRequest {
  readonly market: unknown;
  readonly legalNameBn: unknown;
  readonly legalNameEn: unknown;
  readonly bin: unknown;
  readonly addressBn: unknown;
  readonly addressEn: unknown;
  readonly vatCircle: unknown;
  /** WPU-Y6: optional; an older form without the field leaves it out. */
  readonly tradeLicense?: unknown;
  readonly signatoryName: unknown;
  readonly signatoryDesignation: unknown;
  readonly phone: unknown;
  readonly email: unknown;
  readonly reason: unknown;
}

export interface InvoiceSellerFlow {
  saveInvoiceSeller(
    request: SaveInvoiceSellerRequest,
  ): Promise<FlowAnswer<{ market: string; version: number }>>;
}

export function makeInvoiceSellerFlow(deps: PricingFlowDeps): InvoiceSellerFlow {
  // 1 and 2. Authenticate and authorize: the dependency and then a second look at the role it returned.
  const authorize = async (roles: readonly AdminRole[]): Promise<Authorized> => {
    try {
      const actor = await deps.authorize(roles);
      if (!roles.includes(actor.role)) return { ok: false, answer: fail("denied") };
      return { ok: true, actor };
    } catch {
      return { ok: false, answer: fail("denied") };
    }
  };

  // 4 and 5. Rate limit, then execute in one transaction. Any error is a refusal (R16).
  const execute = async <T>(
    actor: AdminActor,
    work: (tx: Tx) => Promise<FlowAnswer<T>>,
  ): Promise<FlowAnswer<T>> => {
    try {
      if (!(await deps.limiter(actor, deps.clock.now()))) return fail("rate_limited");
      return await deps.run(actor, work);
    } catch {
      return fail("unavailable");
    }
  };

  return {
    async saveInvoiceSeller(request) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, reason } = request;
      const fields: Record<string, unknown> = {};
      for (const key of [...REQUIRED, ...OPTIONAL]) fields[key] = request[key];
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      // 3. Validate: empty optional fields are left out, the rest is the rule of the core.
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      const given: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (
          (OPTIONAL as readonly string[]).includes(key) &&
          (value === "" || value === undefined)
        ) {
          continue;
        }
        given[key] = typeof value === "string" ? value.trim() : value;
      }
      bad.push(...sellerFieldErrors(given));
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || typeof market !== "string") return fail("invalid", bad);
      const seller = given as unknown as SellerRow;
      const actor = auth.actor;
      return execute<{ market: string; version: number }>(actor, async (tx) => {
        const saved = await deps.repos(tx, actor).invoiceSeller.save({ market, seller }, why.text);
        if (!saved.ok) return repoRefusal(saved.error);
        return {
          ok: true,
          replayed: saved.replayed,
          value: { market: saved.value.market, version: saved.value.version },
        };
      });
    },
  };
}

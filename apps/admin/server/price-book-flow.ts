import { isMarket, isUuid } from "./schemas.ts";
import { isFeatureFlag, isPlainDecimal, validateBookTerms } from "@tc/core";
import type { AdminActor, AdminRole, Tx } from "@tc/db";
import { termsOfDraft, startOf } from "./price-book-draft.ts";
import {
  PRICING_ROLES,
  fail,
  readReason,
  refusal,
  repoRefusal,
  type Authorized,
  type FlowAnswer,
  type PricingFlowDeps,
} from "./pricing-flow.ts";

// The actions of the price list (WPA-P1): the margin and the commission of a family, and the base cost of
// the families that no AWS API fills. In the order of R9: authenticate and authorize (finance and
// superadmin), validate, rate limit, execute in one transaction (the same preview the screen showed,
// refused terms are not saved, R16; then the repository write, which stores actor, reason, IP and target
// through `audited`, R10), and a fixed answer. No next/* import. Answers are fixed codes and the NAMES of
// fields, never the text of an engine message or of an error (R14, R16). A change reaches the orders
// priced after its start; an order already placed keeps its stored snapshot.

const BASE_COST = /^\d{1,8}(\.\d{1,4})?$/;

export interface SaveBookRequest {
  readonly market: unknown;
  readonly family: unknown;
  // "percent" or "fixed"; the percent is typed as percent ("15"), the fixed one in paisa for each unit.
  readonly marginKind: unknown;
  readonly margin: unknown;
  // "none", "percent" or "fixed".
  readonly commissionKind: unknown;
  readonly commission: unknown;
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: unknown;
  readonly reason: unknown;
}

export interface SetBaseCostRequest {
  readonly market: unknown;
  readonly family: unknown;
  readonly catalogProductId: unknown;
  readonly awsPriceUsd: unknown;
  readonly reason: unknown;
}

export interface PriceBookFlow {
  saveBook(
    request: SaveBookRequest,
  ): Promise<FlowAnswer<{ family: string; effectiveFrom: Date; laterChangePending: Date | null }>>;
  setBaseCost(
    request: SetBaseCostRequest,
  ): Promise<FlowAnswer<{ family: string; awsPriceUsd: string }>>;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function makePriceBookFlow(deps: PricingFlowDeps): PriceBookFlow {
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
    work: (tx: Tx, at: Date) => Promise<FlowAnswer<T>>,
  ): Promise<FlowAnswer<T>> => {
    try {
      const at = deps.clock.now();
      if (!(await deps.limiter(actor, at))) return fail("rate_limited");
      return await deps.run(actor, (tx) => work(tx, at));
    } catch {
      return fail("unavailable");
    }
  };

  return {
    async saveBook(request) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, family, marginKind, margin, commissionKind, commission, from, reason } =
        request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      // 3. Validate.
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      if (typeof family !== "string" || !isFeatureFlag(family)) bad.push("family");
      const terms = termsOfDraft({
        market: text(market),
        family: text(family),
        marginKind: text(marginKind),
        margin: text(margin).trim(),
        commissionKind: text(commissionKind),
        commission: text(commission).trim(),
        from: text(from),
      });
      if (!terms.ok) bad.push(...terms.fields);
      else if (validateBookTerms(terms.terms).length > 0) bad.push("margin");
      const start = typeof from === "string" ? startOf(from) : null;
      if (start === null) bad.push("from");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || !terms.ok || typeof market !== "string" || typeof family !== "string") {
        return fail("invalid", [...new Set(bad)]);
      }
      const actor = auth.actor;
      const wanted = terms.terms;
      return execute<{ family: string; effectiveFrom: Date; laterChangePending: Date | null }>(
        actor,
        async (tx, at) => {
          const once = { now: () => at };
          // The preview of this very entry runs in the same transaction; terms the engine refuses (or a
          // family with no rate or rule in force) are not saved (R16). The screen shows the same preview.
          const shown = await deps.core.previewBook(
            tx,
            { market, productFamily: family, terms: wanted },
            once,
          );
          if (!shown.ok) return refusal(shown);
          const effectiveFrom = start ?? at;
          const saved = await deps.repos(tx, actor).priceBook.save(
            {
              market,
              family,
              margin: wanted.margin,
              commission: wanted.commission,
              effectiveFrom,
              at,
            },
            why.text,
          );
          if (!saved.ok) return repoRefusal(saved.error);
          return {
            ok: true,
            replayed: saved.replayed,
            value: {
              family: saved.value.family,
              effectiveFrom: saved.value.entry.from,
              laterChangePending: saved.value.laterChangePending,
            },
          };
        },
      );
    },

    async setBaseCost(request) {
      const { market, family, catalogProductId, awsPriceUsd, reason } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      if (typeof family !== "string" || !isFeatureFlag(family)) bad.push("family");
      if (!isUuid(catalogProductId)) bad.push("product");
      const usd = typeof awsPriceUsd === "string" ? awsPriceUsd.trim() : "";
      if (!BASE_COST.test(usd) || !isPlainDecimal(usd) || !/[1-9]/.test(usd))
        bad.push("awsPriceUsd");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (
        bad.length > 0 ||
        typeof market !== "string" ||
        typeof family !== "string" ||
        typeof catalogProductId !== "string"
      ) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ family: string; awsPriceUsd: string }>(actor, async (tx, at) => {
        const once = { now: () => at };
        // The product must be one of the family (a forged family or id is refused) and the new price
        // must price: the same preview as the screen, in this transaction (R16).
        const shown = await deps.core.previewBook(
          tx,
          {
            market,
            productFamily: family,
            base: { productId: catalogProductId.toLowerCase(), awsPriceUsd: usd },
          },
          once,
        );
        if (!shown.ok) return refusal(shown);
        const saved = await deps
          .repos(tx, actor)
          .priceBook.setBaseCost({ catalogProductId, awsPriceUsd: usd }, why.text);
        if (!saved.ok) return repoRefusal(saved.error);
        return {
          ok: true,
          replayed: saved.replayed,
          value: { family: saved.value.family, awsPriceUsd: saved.value.awsPriceUsd },
        };
      });
    },
  };
}

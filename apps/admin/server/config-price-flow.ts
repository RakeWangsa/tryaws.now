import { isMarket } from "./schemas.ts";
import {
  CONFIG_PRICE_TEXT,
  isConfigPriceKey,
  type AdminActor,
  type AdminRole,
  type Tx,
} from "@tc/db";
import { startOf } from "./price-book-draft.ts";
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

// The action of /pricing/config (WPU-G10): the prices that no AWS API fills (load balancer, snapshot and
// block storage, hosted zone), with the start of each. In the order of R9: authenticate and authorize
// (finance and superadmin), validate, rate limit, execute in one transaction (the same preview the screen
// showed, then the repository write, which stores actor, reason, IP and target through `audited`, R10),
// and a fixed answer. No next/* import. Answers are fixed codes and the NAMES of fields, never the text of an
// engine message or of an error (R14, R16). A change reaches the orders priced after its start; an order
// already placed keeps its stored snapshot, and so does a renewal of the running period.

export interface SaveConfigPriceRequest {
  readonly market: unknown;
  readonly key: unknown;
  // Plain decimal text, USD for one billing unit.
  readonly usd: unknown;
  // Dhaka wall time "YYYY-MM-DDTHH:mm" or "" for now.
  readonly from: unknown;
  readonly reason: unknown;
}

export interface ConfigPriceFlow {
  saveConfigPrice(
    request: SaveConfigPriceRequest,
  ): Promise<FlowAnswer<{ key: string; effectiveFrom: Date; laterChangePending: Date | null }>>;
}

export function makeConfigPriceFlow(deps: PricingFlowDeps): ConfigPriceFlow {
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
    async saveConfigPrice(request) {
      // Read once into locals, so a getter cannot answer differently on the second read.
      const { market, key, usd, from, reason } = request;
      const auth = await authorize(PRICING_ROLES);
      if (!auth.ok) return auth.answer;
      // 3. Validate.
      const bad: string[] = [];
      if (!isMarket(market)) bad.push("market");
      if (!isConfigPriceKey(key)) bad.push("key");
      const price = typeof usd === "string" ? usd.trim() : "";
      if (!CONFIG_PRICE_TEXT.test(price) || !/[1-9]/.test(price)) bad.push("usd");
      const start = typeof from === "string" ? startOf(from) : null;
      if (start === null) bad.push("from");
      const why = readReason(reason);
      if (!why.ok) bad.push("reason");
      if (bad.length > 0 || typeof market !== "string" || !isConfigPriceKey(key)) {
        return fail("invalid", bad);
      }
      const actor = auth.actor;
      return execute<{ key: string; effectiveFrom: Date; laterChangePending: Date | null }>(
        actor,
        async (tx, at) => {
          const once = { now: () => at };
          // The preview of this very price runs in the same transaction; a price the engine cannot price
          // (no rate or rule in force) is not saved (R16). The screen shows the same preview.
          const shown = await deps.core.previewConfigPrice(tx, { market, key, usd: price }, once);
          if (!shown.ok) return refusal(shown);
          const effectiveFrom = start ?? at;
          const saved = await deps
            .repos(tx, actor)
            .configPrices.save({ market, key, usd: price, effectiveFrom, at }, why.text);
          if (!saved.ok) return repoRefusal(saved.error);
          return {
            ok: true,
            replayed: saved.replayed,
            value: {
              key: saved.value.key,
              effectiveFrom: saved.value.entry.from,
              laterChangePending: saved.value.laterChangePending,
            },
          };
        },
      );
    },
  };
}

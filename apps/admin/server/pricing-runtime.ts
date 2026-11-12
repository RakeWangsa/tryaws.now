import { createHmac } from "node:crypto";
import {
  fxChangeNeedsSecondAdmin,
  previewBook,
  previewChange,
  savePricingRule,
  setFeatureFlag,
  setFxRate,
} from "@tc/core";
import { requireAdmin } from "@tc/auth";
import {
  adminRepos,
  consumeRateLimits,
  readFxRateInForce,
  withTx,
  type AdminActor,
  type Tx,
} from "@tc/db";
import type { PricingFlowDeps } from "./pricing-flow.ts";
import { ensureAdminAuth } from "./runtime.ts";

// The composition of the pricing, FX, catalog and flag screens (WP8-T4). Its own module so that the other
// WP8 screens add theirs without touching this one. Server code only; the only place of these screens that
// reads process.env or touches the database.

// 30 changes for each admin in 10 minutes: an editing session needs a few, a script a lot more.
const ACTION_LIMIT = 30;
const WINDOW_SECONDS = 600;
const RATE_KEY = "tc-admin-pricing-v1";

const subjectOf = (id: string): string =>
  createHmac("sha256", RATE_KEY).update(id).digest("hex").slice(0, 32);

export function pricingFlowDeps(): PricingFlowDeps {
  ensureAdminAuth();
  return {
    authorize: (roles) => requireAdmin([...roles]),
    limiter: (actor: AdminActor, now: Date) =>
      withTx(async (tx) => {
        const decision = await consumeRateLimits(
          tx,
          [
            {
              kind: "ip",
              subject: subjectOf(actor.adminId),
              action: "admin_pricing_action",
              limit: ACTION_LIMIT,
              windowSeconds: WINDOW_SECONDS,
            },
          ],
          now,
        );
        return decision.allowed;
      }),
    run: (_actor, fn) => withTx(fn),
    repos: (tx: Tx, actor: AdminActor) => adminRepos(tx, actor),
    clock: { now: () => new Date() },
    core: {
      previewBook,
      previewChange,
      savePricingRule,
      setFxRate,
      setFeatureFlag,
      fxInForce: (tx, market, at) => readFxRateInForce(tx, market, at),
      needsSecondAdmin: fxChangeNeedsSecondAdmin,
    },
    stage: process.env["TC_STAGE"] ?? "",
  };
}

// The reads of the screens, in one transaction (R9 steps 1 and 2 were done by loadPageAdmin).
export const readTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTx(fn);

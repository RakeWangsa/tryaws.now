import { customerRepos, readCatalogProduct } from "@tc/db";
import { checkCapacity } from "../capacity/check";
import type { Logger, OperationQueue, RunTx } from "../operations/index";
import { resolveProduct } from "../products/instance";
import { quoteInForce } from "../rates/in-force";
import type { Clock, Result } from "../types";
import { gateCustomer, gateKeyPair, gateProduct } from "./checks";
import { INTERNAL, runGuarded } from "./guard";
import { assertSecrets, signDraft } from "./token";
import { DRAFT_TTL_SECONDS, type DraftClaims, type OrderDraft, type OrderSession } from "./types";

/**
 * What the order functions need from the outside. Nothing here is read from the environment (R3).
 * `run` runs one database transaction as web_rw.
 */
export interface OrdersDeps {
  readonly run: RunTx;
  readonly clock: Clock;
  readonly secrets: readonly Uint8Array[];
  readonly queue: OperationQueue;
  /** Fixed-text structured events only; never a token, a key or a person (R14). */
  readonly log?: Logger;
}

const FAMILY = /^[a-z][a-z_]{0,39}$/;

function readInput(input: unknown): Result<{ family: string; config: unknown }> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "validation", fields: { input: "invalid" } };
  }
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("family") || !keys.includes("config")) {
    return { ok: false, error: "validation", fields: { input: "invalid" } };
  }
  const { family, config } = input as { family: unknown; config: unknown };
  if (typeof family !== "string" || !FAMILY.test(family)) {
    return { ok: false, error: "validation", fields: { family: "invalid" } };
  }
  return { ok: true, value: { family, config } };
}

/**
 * F: createOrderDraft. One read-only transaction: it takes no lock and writes no row (16.11 step 2).
 * The balance is not checked here; the review page shows the shortfall (step 4). Every refusal is a
 * `Result`; a missing secret throws before anything else.
 */
export async function createDraft(
  deps: OrdersDeps,
  session: OrderSession,
  input: unknown,
): Promise<Result<OrderDraft>> {
  assertSecrets(deps.secrets);
  const parsed = readInput(input);
  if (!parsed.ok) return parsed;
  const now = deps.clock.now();

  const drafted = await runGuarded(deps, async (tx): Promise<Result<OrderDraft>> => {
    const resolved = await resolveProduct(parsed.value.family, parsed.value.config, (id) =>
      readCatalogProduct(tx, id),
    );
    if (!resolved.ok) return resolved;
    const product = resolved.value;

    const repos = customerRepos(tx, session.customerId);
    const customer = await gateCustomer(repos);
    if (!customer.ok) return customer;

    const gated = await gateProduct(tx, repos, customer.value, product);
    if (!gated.ok) return gated;

    const keyed = await gateKeyPair(repos, product);
    if (!keyed.ok) return keyed;

    // "Available but not yet reserved": no lock, no unit taken, no waitlist entry.
    const room = await checkCapacity(tx, {
      customerId: session.customerId,
      region: product.region,
      needs: product.needs,
    });
    if (!room.ok) return room;

    const priced = await quoteInForce(
      tx,
      {
        market: customer.value.market,
        productFamily: product.family,
        awsPriceUsd: product.awsPriceUsd,
        ...(product.quantity === undefined ? {} : { quantity: product.quantity }),
      },
      { now: () => now },
    );
    if (!priced.ok) return priced;

    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + DRAFT_TTL_SECONDS;
    const claims: DraftClaims = {
      v: 1,
      c: session.customerId,
      fam: product.family,
      pid: product.productId,
      region: product.region,
      cfg: product.resourceConfig,
      snap: priced.value.snapshot,
      iat,
      exp,
    };
    return {
      ok: true,
      value: {
        token: signDraft(deps.secrets, claims),
        quote: priced.value.quote,
        expiresAt: new Date(exp * 1000),
      },
    };
  });
  // A database error is `internal` and says nothing (R14, R16).
  return drafted.done ? drafted.value : INTERNAL;
}

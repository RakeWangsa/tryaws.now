import { customerRepos, findLedgerTransactionByKey, type Tx } from "@tc/db";
import { reserveCapacity, type Reservation } from "../capacity/reserve";
import { DNS_ZONE_TERM_DAYS } from "../dns/zone";
import { DOMAIN_TERM_DAYS } from "../domains/resolve";
import { lockWallet } from "../ledger/balance";
import { ledgerKey } from "../ledger/keys";
import { postTransaction } from "../ledger/post";
import type { Posting } from "../ledger/types";
import { makeEnqueueOperation } from "../operations/enqueue";
import { accountFor } from "../pricing/index";
import { quoteInForce } from "../rates/in-force";
import type { Result } from "../types";
import { gateCustomer, gateImage, gateKeyPair, gateProduct, resolveOrderProduct } from "./checks";
import { comparePrice } from "./compare";
import type { OrdersDeps } from "./draft";
import { sqlState } from "./guard";
import { childId, orderIdFor } from "./ids";
import { DRAFT_TTL_SECONDS, type DraftClaims } from "./types";

export interface PurchaseArgs {
  readonly claims: DraftClaims;
  readonly tokenHash: string;
  readonly clientKey: string;
  readonly customerId: string;
}

export type Purchased = {
  readonly orderId: string;
  readonly resourceId: string;
  readonly operationId: string;
  readonly replayed: boolean;
};

const TERM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

type Repos = ReturnType<typeof customerRepos>;

/** A unique violation (23505) of any statement of the writes, whatever layer wrapped it. */
function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === "23505";
}

/**
 * The purchase of this very token, if one is committed: the order and the ids it made. An order that
 * was reversed (the automatic refund of a failed create) is `"reversed"`: the purchase of the token
 * is over, so a replay must not answer ok for it, and nothing may be charged again.
 */
async function findPurchase(
  tx: Tx,
  repos: Repos,
  orderId: string,
  tokenHash: string,
): Promise<Purchased | "reversed" | null> {
  const ledger = await findLedgerTransactionByKey(tx, ledgerKey.purchase(tokenHash));
  const order =
    ledger === null
      ? await repos.orders.get(orderId)
      : await repos.orders.findByLedgerTransaction(ledger.id);
  if (order === null) {
    // Money moved and no order exists: an invariant the nightly check also catches (R16).
    if (ledger !== null) throw new Error("orders: a purchase has no order");
    return null;
  }
  if (order.id !== orderId) throw new Error("orders: the order of a purchase is another order");
  if (order.status === "reversed") return "reversed";
  const resourceId = childId(orderId, "resource");
  const operation = (await repos.operations.listForResource(resourceId)).find(
    (op) => op.kind === "create",
  );
  if (operation === undefined) throw new Error("orders: a purchase has no create operation");
  return { orderId, resourceId, operationId: operation.id, replayed: true };
}

/**
 * The answer for a signed draft that has expired: the order of that very draft if one was placed
 * (a retry after a lost answer), `conflict` if it was reversed, else null (it never became an order).
 * Reads only; no lock, no write, no charge. The caller has checked that the draft names the customer.
 */
export async function replayOfExpiredDraft(
  tx: Tx,
  args: { readonly tokenHash: string; readonly customerId: string },
): Promise<Result<{ orderId: string }> | null> {
  const orderId = orderIdFor(args.customerId, args.tokenHash);
  const found = await findPurchase(tx, customerRepos(tx, args.customerId), orderId, args.tokenHash);
  if (found === null) return null;
  return found === "reversed"
    ? { ok: false, error: "conflict" }
    : { ok: true, value: { orderId: found.orderId } };
}

/** Same client key, another purchase: a conflict. Nothing is written. */
async function clientKeyIsTaken(repos: Repos, clientKey: string): Promise<boolean> {
  return (await repos.orders.findByIdempotencyKey(clientKey)) !== null;
}

/**
 * The purchase transaction of Section 3.4, run inside the caller's `withTx` as web_rw. The order of
 * the steps is the design: the wallet row is locked first and the capacity cells last, and every
 * check that can refuse runs before the first unit is taken. A refusal is returned before the
 * reservation, when nothing has been written. From the reservation on, a failure only throws, because
 * `withTx` commits a returned failure.
 */
export async function runPurchase(
  tx: Tx,
  deps: Pick<OrdersDeps, "clock">,
  args: PurchaseArgs,
): Promise<Result<Purchased>> {
  const { claims, tokenHash, clientKey, customerId } = args;
  // The token is accepted only from the customer it names (16.11 step 2). placeOrder checks this too.
  if (claims.c !== customerId) return { ok: false, error: "forbidden" };
  const now = deps.clock.now();
  const orderId = orderIdFor(customerId, tokenHash);
  const repos = customerRepos(tx, customerId);

  // 2. Lock. A customer without a wallet throws and nothing is written (R16).
  const balance = await lockWallet(tx, customerId);

  // 3. Replay. One draft gives at most one order, whatever the client key is.
  const earlier = await findPurchase(tx, repos, orderId, tokenHash);
  if (earlier === "reversed") return { ok: false, error: "conflict" };
  if (earlier !== null) return { ok: true, value: earlier };
  if (await clientKeyIsTaken(repos, clientKey)) return { ok: false, error: "conflict" };

  // 4. Customer, from the row under the lock. The session is not an input.
  // Read `for share`: a KYC revocation or a suspension that commits between this check and the
  // charge waits for this transaction instead of being missed.
  const customer = await gateCustomer(repos, { lock: "share" });
  if (!customer.ok) return customer;

  // 5. Family, product, flag and limits, a second time.
  const resolved = await resolveOrderProduct(tx, repos, customerId, claims.fam, claims.cfg, now);
  if (!resolved.ok) return resolved;
  const product = resolved.value;
  if (product.productId !== claims.pid || product.region !== claims.region) {
    return { ok: false, error: "validation", fields: { token: "invalid" } };
  }
  const gated = await gateProduct(tx, repos, customer.value, product);
  if (!gated.ok) return gated;
  // The key pair of the configuration is the customer's own, read through the scoped repository.
  const keyed = await gateKeyPair(repos, product);
  if (!keyed.ok) return keyed;
  // WPU-G3: the image and the key of a new Linux server, again: the allow-list may have changed.
  const imaged = await gateImage(tx, customer.value, product);
  if (!imaged.ok) return imaged;

  // 6. Price, again, and compare with the token.
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
  const fresh = priced.value.snapshot;
  if (!comparePrice(claims.snap, fresh).same) {
    const iat = Math.floor(now.getTime() / 1000);
    const next: DraftClaims = { ...claims, snap: fresh, iat, exp: iat + DRAFT_TTL_SECONDS };
    return { ok: false, error: "price_changed", data: { claims: next } };
  }

  // 7. Balance.
  const total = BigInt(fresh.totalMinor);
  if (balance < total) {
    return {
      ok: false,
      error: "insufficient_balance",
      data: { shortfallMinor: (total - balance).toString() },
    };
  }

  // The postings are built before the first unit is taken, so a step with no ledger account stops here.
  const postings: Posting[] = [
    { account: { type: "customer_wallet", customerId }, direction: "debit", amountMinor: total },
    {
      account: { type: "revenue_aws_base" },
      direction: "credit",
      amountMinor: BigInt(fresh.baseMinor),
    },
  ];
  for (const step of fresh.steps) {
    const amountMinor = BigInt(step.amountMinor);
    if (amountMinor === 0n) continue; // a step of 0 posts no line
    const type = accountFor(step.code);
    if (type === undefined) throw new Error("orders: a price step has no ledger account");
    postings.push({ account: { type }, direction: "credit", amountMinor });
  }

  // 8 and 9 are one savepoint. A unique violation inside it rolls the savepoint back, and the replay
  // lookups run again: it is a replay or a conflict, never a second charge.
  let result: Result<Purchased>;
  try {
    result = await tx.transaction(async (sp) => {
      const spRepos = customerRepos(sp, customerId);
      const termDays =
        product.family === "domain"
          ? DOMAIN_TERM_DAYS
          : product.family === "dns_zone"
            ? DNS_ZONE_TERM_DAYS
            : TERM_DAYS;

      // 8. Capacity, last of the checks. No waitlist argument: the page offers it (open point 12).
      // A domain and a DNS zone live in tc-dns: no pool account, no capacity cell, no catalog product
      // (WP7-T4, WPU-G6).
      const isDomain = product.family === "domain";
      const isPlaceless = isDomain || product.family === "dns_zone";
      let reservation: Reservation | null = null;
      if (!isPlaceless) {
        const reserved = await reserveCapacity(sp, {
          customerId,
          region: product.region,
          needs: product.needs,
        });
        if (!reserved.ok) return reserved;
        reservation = reserved.value;
      }

      // From here on nothing returns a failure: every refusal throws a fixed text.
      const resourceId = childId(orderId, "resource");
      await spRepos.orders.createResource({
        id: resourceId,
        family: product.family,
        productId: isPlaceless ? null : product.productId,
        poolAccountId: reservation === null ? null : reservation.poolAccountId,
        region: product.region,
        config:
          reservation === null
            ? { ...product.resourceConfig }
            : { ...product.resourceConfig, capacityReservation: reservation.record },
      });

      const posted = await postTransaction(sp, {
        kind: "purchase",
        reference: { type: "order", id: orderId },
        idempotencyKey: ledgerKey.purchase(tokenHash),
        actor: { type: "customer", id: customerId },
        postings,
      });
      if (!posted.ok) throw new Error("orders: the purchase posting was refused");

      const order = await spRepos.orders.createPaid({
        id: orderId,
        items: [
          {
            resourceId,
            family: product.family,
            productId: product.productId,
            region: product.region,
          },
        ],
        priceSnapshot: fresh,
        totalMinor: total,
        ledgerTransactionId: posted.value.transactionId,
        idempotencyKey: clientKey,
      });
      if (!order.ok || order.replayed) throw new Error("orders: the order was not created");

      const subscription = await spRepos.orders.createSubscription({
        id: childId(orderId, "subscription"),
        resourceId,
        termDays: termDays,
        priceSnapshot: fresh,
        periodStart: now,
        periodEnd: new Date(now.getTime() + termDays * DAY_MS),
      });
      if (!subscription.ok) throw new Error("orders: the subscription was not created");

      // The registrant contact stays sealed: the row holds the envelope the action made (R14).
      const review = product.resourceConfig["review"] === true;
      if (isDomain) {
        const name = product.resourceConfig["name"];
        const tld = product.resourceConfig["tld"];
        const sealed = product.resourceConfig["contactSealed"];
        if (typeof name !== "string" || typeof tld !== "string" || typeof sealed !== "string") {
          throw new Error("orders: the domain configuration is incomplete");
        }
        const row = await spRepos.domains.create({
          id: childId(orderId, "domain"),
          resourceId,
          name,
          tld,
          status: review ? "review" : "pending",
          contactEncrypted: new Uint8Array(Buffer.from(sealed, "base64")),
        });
        if (!row.ok) throw new Error("orders: the domain row was not created");
      }

      if (product.family === "dns_zone") {
        const zoneName = product.resourceConfig["zoneName"];
        if (typeof zoneName !== "string") {
          throw new Error("orders: the zone configuration is incomplete");
        }
        const row = await spRepos.dnsZones.create({
          id: childId(orderId, "zone"),
          resourceId,
          name: zoneName,
          status: "pending",
        });
        if (!row.ok) throw new Error("orders: the zone row was not created");
      }

      // A TLD with extra parameters waits for an admin before RegisterDomain (spec 12): the operation
      // row is `needs_approval` and shows in the admin operations screen.
      const { operationId } = await makeEnqueueOperation(deps.clock)(sp, {
        resourceId,
        kind: "create",
        // A restore names its backup; the adapter reads it from the payload (WP5-T1).
        payload: {
          orderId,
          ...(product.restoreFromBackupId === undefined
            ? {}
            : { restoreFromBackupId: product.restoreFromBackupId }),
        },
        idempotencyKey: `order-create:${orderId}`,
        ...(review ? { needsApproval: true } : {}),
      });

      // Ids and enums only: no token, no key, no configuration text (R14).
      const audited = await spRepos.audit.record({
        action: "order.placed",
        targetType: "order",
        targetId: orderId,
        metadata: { totalMinor: total.toString(), family: product.family },
      });
      if (!audited.ok) throw new Error("orders: the audit entry was refused");

      return { ok: true, value: { orderId, resourceId, operationId, replayed: false } };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await findPurchase(tx, repos, orderId, tokenHash);
    return again !== null && again !== "reversed"
      ? { ok: true, value: again }
      : { ok: false, error: "conflict" };
  }
  return result;
}

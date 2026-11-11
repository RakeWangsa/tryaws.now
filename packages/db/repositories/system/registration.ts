import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../../client";
import { insertWallet, insertWalletAccount } from "../../ledger/accounts";
import { LOCALES } from "../../schema/identity";
import { insertAudit } from "../audit-log";
import { isMarketCode } from "../config/args";
import { readMarket } from "../config/markets";

// The one place where a customer row is created (WP2-T2). The row needs the Cognito sub, which exists
// only after SignUp, so there is no customer id yet and no customerRepos scope: the id is made here,
// and it is the only thing that comes out. Only packages/auth names this function (guard in
// tests/repo/auth-boundaries.test.mjs). It is not part of customerRepos and no function of it takes a
// customer id as input. Individual accounts only: a business account and its company name are
// deferred (no column; Needs decision), so `type` is the constant "individual".

export type LegalDocument = "terms" | "acceptable_use" | "privacy";
const DOCUMENTS: readonly LegalDocument[] = ["terms", "acceptable_use", "privacy"];

export interface NewCustomer {
  readonly cognitoSub: string; // 1..128 chars
  readonly email: string; // already normalised by @tc/core
  readonly phone: string; // canonical +880..., unverified (phone_verified_at stays NULL)
  readonly name: string;
  readonly market: string;
  readonly locale: "bn" | "en";
  // Exactly these three documents, each once.
  readonly acceptances: readonly { readonly document: LegalDocument; readonly version: string }[];
  readonly ip: string; // inet, from CloudFront-Viewer-Address
  readonly userAgent?: string; // <= 256 chars, stored in the audit row only
}

export type Registered =
  | { readonly ok: true; readonly customerId: string; readonly replayed: boolean }
  | { readonly ok: false; readonly error: "validation" | "market_unavailable" };

const CONTROL = /\p{Cc}/u;
const PHONE = /^\+8801[3-9][0-9]{8}$/;
const MAX_SUB_LENGTH = 128;

const inRange = (s: unknown, min: number, max: number): s is string =>
  typeof s === "string" && s.length >= min && s.length <= max;

// The same check registerCustomer makes first, exported so that packages/auth can refuse a bad input
// before it creates a user at the identity provider (an orphan otherwise). No query.
export function isNewCustomerValid(input: NewCustomer): boolean {
  if (typeof input !== "object" || input === null) return false;
  if (!inRange(input.cognitoSub, 1, MAX_SUB_LENGTH)) return false;
  // An address in its normal form: one "@", no space, no control character, at most 254 characters.
  if (
    !inRange(input.email, 3, 254) ||
    CONTROL.test(input.email) ||
    /\s/.test(input.email) ||
    input.email.indexOf("@") < 1 ||
    input.email.indexOf("@") !== input.email.lastIndexOf("@") ||
    input.email.endsWith("@")
  ) {
    return false;
  }
  if (typeof input.phone !== "string" || !PHONE.test(input.phone)) return false;
  if (!inRange(input.name, 2, 200) || CONTROL.test(input.name)) return false;
  if (!isMarketCode(input.market)) return false;
  if (!(LOCALES as readonly string[]).includes(input.locale)) return false;
  // isIP accepts an address and nothing else: no mask, no zone, no port.
  if (typeof input.ip !== "string" || isIP(input.ip) === 0) return false;
  if (input.userAgent !== undefined && !inRange(input.userAgent, 0, 256)) return false;
  if (!Array.isArray(input.acceptances) || input.acceptances.length !== DOCUMENTS.length) {
    return false;
  }
  const seen = new Set<string>();
  for (const a of input.acceptances) {
    if (typeof a !== "object" || a === null) return false;
    if (!(DOCUMENTS as readonly string[]).includes(a.document) || seen.has(a.document)) {
      return false;
    }
    if (!inRange(a.version, 1, 64) || CONTROL.test(a.version)) return false;
    seen.add(a.document);
  }
  return true;
}

// Order, all inside the caller's transaction (a throw rolls everything back): validate, read the
// market, insert the customer by the unique cognito_sub, then either the three acceptances (a new
// row) or the id of the existing row (a replay), the wallet account and the wallet in both cases
// (both are `on conflict do nothing`, so a replay repairs a half-made account), and the audit row for
// a new customer only. The audit metadata holds the market and the type, never an email, a phone
// number or a name.
export async function registerCustomer(tx: Tx, input: NewCustomer): Promise<Registered> {
  if (!isNewCustomerValid(input)) return { ok: false, error: "validation" };
  const market = await readMarket(tx, input.market);
  if (market === null || !market.active) return { ok: false, error: "market_unavailable" };

  const inserted = await tx.execute<{ id: string }>(
    sql`insert into customers (id, cognito_sub, email, phone, name, type, market, locale) values (${uuidv7()}, ${input.cognitoSub}, ${input.email}, ${input.phone}, ${input.name}, 'individual', ${input.market}, ${input.locale}) on conflict on constraint customers_cognito_sub_unique do nothing returning id`,
  );
  const created = inserted.rows[0];
  let customerId: string;
  if (created !== undefined) {
    customerId = created.id;
    for (const a of input.acceptances) {
      await tx.execute(
        sql`insert into legal_acceptances (id, customer_id, document, version, ip) values (${uuidv7()}, ${customerId}, ${a.document}, ${a.version}, ${input.ip}::inet)`,
      );
    }
  } else {
    const existing = await tx.execute<{ id: string }>(
      sql`select id from customers where cognito_sub = ${input.cognitoSub}`,
    );
    const row = existing.rows[0];
    // The conflict said the row exists; a missing row now cannot be repaired here (R16).
    if (row === undefined) throw new Error("registerCustomer: the customer row is not readable");
    customerId = row.id;
  }

  await insertWalletAccount(tx, customerId, market.currency);
  await insertWallet(tx, customerId, market.currency);

  if (created !== undefined) {
    await insertAudit(tx, {
      actorType: "customer",
      actorId: customerId,
      action: "customer.register",
      targetType: "customer",
      targetId: customerId,
      ip: input.ip,
      ...(input.userAgent === undefined ? {} : { userAgent: input.userAgent }),
      metadata: { market: input.market, type: "individual" },
    });
  }
  return { ok: true, customerId, replayed: created === undefined };
}

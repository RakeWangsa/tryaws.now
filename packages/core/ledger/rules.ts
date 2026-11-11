import { STEP_ACCOUNTS } from "../pricing/validate";
import { ledgerKey } from "./keys";
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_CURRENCY,
  LEDGER_KINDS,
  MAX_KEY_LENGTH,
  MAX_MEMO_LENGTH,
  MAX_MINOR,
  MAX_POSTINGS,
  type LedgerAccountRef,
  type LedgerAccountType,
  type LedgerKind,
  type Posting,
} from "./types";
import { isUuid } from "./uuid";

// Spec 9.1 and open point 5: the check of a posting request (shape, amounts, currency, balance, then
// the lines of each kind, who may post it, the key family and the reason).
// Pure: no database, no clock, no throw. A text of a problem is a constant of this file, never built
// from the input (R14), and an amount is compared as a bigint only after `typeof` said it is one (R4).

export type ActorType = "customer" | "admin" | "system";

export type Shape =
  /** Exactly two lines: a debit and a credit whose account types form one of the pairs. */
  | { readonly pairs: readonly (readonly [debit: LedgerAccountType, credit: LedgerAccountType])[] }
  /** One debit line, one or more credit lines, each `required` type once. */
  | {
      readonly debit: LedgerAccountType;
      readonly credits: readonly LedgerAccountType[];
      readonly required: readonly LedgerAccountType[];
    }
  | "free";

export interface KindRule {
  /** The actor types that may post the kind. */
  readonly actors: readonly ActorType[];
  /** The type of the row that points at the ledger transaction; `null`: any word of the form of `reference.type`. */
  readonly referenceType: string | null;
  /** The key family of the kind; `referenceId` is in lower case. */
  readonly keyOk: (key: string, referenceId: string) => boolean;
  /** The actor types that must give a reason (9.1: "with reason"; R10). */
  readonly memoRequiredFor: readonly ActorType[];
  readonly shape: Shape;
}

// 9.1: a step above 0 is a credit line, a step of 0 posts no line; revenue_aws_base is always there.
const SALE_CREDITS: readonly LedgerAccountType[] = [
  "revenue_aws_base",
  ...Object.values(STEP_ACCOUNTS),
];
const SALE: Shape = {
  debit: "customer_wallet",
  credits: SALE_CREDITS,
  required: ["revenue_aws_base"],
};

const startsWith = (prefix: string) => (key: string) => key.startsWith(prefix);
// A frozen row, typed as a `KindRule` so that the functions and the lists get their types from it.
const row = (rule: KindRule): KindRule => Object.freeze(rule);

/** The table of 9.1, one row per kind. The rows of `reversal` are used by `reverseTransaction` only. */
export const KIND_RULES: Readonly<Record<LedgerKind, KindRule>> = Object.freeze({
  topup: row({
    actors: ["system", "admin"],
    referenceType: "payment",
    keyOk: (key, id) => key === ledgerKey.topup(id),
    memoRequiredFor: [],
    shape: { pairs: [["gateway_clearing", "customer_wallet"]] },
  }),
  purchase: row({
    actors: ["customer", "system"],
    referenceType: "order",
    keyOk: startsWith("order:"),
    memoRequiredFor: [],
    shape: SALE,
  }),
  renewal: row({
    actors: ["customer", "system"],
    referenceType: "subscription",
    keyOk: (key, id) => key.startsWith(`renew:${id}:`),
    memoRequiredFor: [],
    shape: SALE,
  }),
  metered_charge: row({
    actors: ["system"],
    referenceType: "resource",
    keyOk: (key, id) => key.startsWith(`meter:${id}:`),
    memoRequiredFor: [],
    shape: SALE,
  }),
  reversal: row({
    actors: ["admin", "system"],
    referenceType: "ledger_transaction",
    keyOk: (key, id) => {
      if (key === ledgerKey.reversal(id)) return true;
      const prefix = "order-reversal:";
      return key.startsWith(prefix) && isUuid(key.slice(prefix.length));
    },
    memoRequiredFor: ["admin"],
    shape: "free",
  }),
  adjustment: row({
    actors: ["admin", "system"],
    referenceType: "wallet_adjustment",
    keyOk: (key, id) => key === ledgerKey.adjustment(id),
    memoRequiredFor: ["admin", "system"],
    shape: {
      pairs: [
        ["adjustments", "customer_wallet"],
        ["customer_wallet", "adjustments"],
      ],
    },
  }),
  refund: row({
    actors: ["admin", "system"],
    referenceType: null,
    keyOk: (key, id) => key === ledgerKey.refund(id),
    memoRequiredFor: ["admin", "system"],
    shape: { pairs: [["customer_wallet", "refunds"]] },
  }),
});

export interface NormalizedLine {
  readonly account: {
    readonly type: LedgerAccountType;
    readonly customerId: string | null;
    readonly currency: string;
  };
  readonly direction: "debit" | "credit";
  readonly amountMinor: bigint;
}

export interface NormalizedPosting {
  readonly kind: LedgerKind;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly idempotencyKey: string;
  readonly actor: { readonly type: "customer" | "admin" | "system"; readonly id: string | null };
  readonly memo: string | null;
  readonly currency: string;
  readonly lines: readonly NormalizedLine[];
  readonly walletCustomerId: string | null;
  readonly walletDelta: bigint;
}

export type CheckedPosting =
  | { readonly ok: true; readonly value: NormalizedPosting }
  | {
      readonly ok: false;
      readonly error: "validation" | "forbidden";
      readonly fields: Record<string, string>;
    };

const REFERENCE_TYPE = /^[a-z][a-z0-9_]{0,39}$/;
const KEY = /^[!-~]+$/;
const CURRENCY = /^[A-Z]{3}$/;

const KINDS: readonly unknown[] = LEDGER_KINDS;
const ACCOUNT_TYPES: readonly unknown[] = LEDGER_ACCOUNT_TYPES;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The result of `parseLine`: either every field is valid, or `line` is null. */
function parseLine(
  raw: unknown,
  at: string,
  flag: (path: string, text: string) => void,
): NormalizedLine | null {
  if (!isObject(raw)) {
    flag(at, "The posting must be an object.");
    return null;
  }
  let valid = true;
  const fail = (path: string, text: string) => {
    flag(path, text);
    valid = false;
  };

  let type: LedgerAccountType | null = null;
  let customerId: string | null = null;
  let currency: string = LEDGER_CURRENCY;
  const account = raw.account;
  if (!isObject(account)) {
    fail(`${at}.account`, "The account must be an object.");
  } else {
    if (!ACCOUNT_TYPES.includes(account.type)) {
      fail(`${at}.account`, "The account type is not known.");
    } else {
      type = account.type as LedgerAccountType;
      if (type === "customer_wallet") {
        if (isUuid(account.customerId)) customerId = account.customerId.toLowerCase();
        else fail(`${at}.account.customerId`, "A customer wallet needs the id of a customer.");
      } else if (account.customerId !== undefined) {
        fail(`${at}.account.customerId`, "Only a customer wallet belongs to a customer.");
      }
    }
    if (account.currency !== undefined) {
      if (typeof account.currency === "string" && CURRENCY.test(account.currency)) {
        currency = account.currency;
      } else {
        fail(`${at}.account.currency`, "The currency must be three capital letters.");
      }
    }
  }

  let direction: "debit" | "credit" | null = null;
  if (raw.direction === "debit" || raw.direction === "credit") direction = raw.direction;
  else fail(`${at}.direction`, "The direction must be debit or credit.");

  const amount = raw.amountMinor;
  let amountMinor: bigint | null = null;
  if (typeof amount !== "bigint") {
    fail(`${at}.amountMinor`, "The amount must be a bigint of minor units.");
  } else if (amount <= 0n || amount > MAX_MINOR) {
    fail(`${at}.amountMinor`, "The amount must be above 0 and within the range of the database.");
  } else {
    amountMinor = amount;
  }

  if (!valid || type === null || direction === null || amountMinor === null) return null;
  return { account: { type, customerId, currency }, direction, amountMinor };
}

export function checkPosting(
  input: unknown,
  options?: { allowReversal?: boolean },
): CheckedPosting {
  const bad: Record<string, string> = {};
  const flag = (path: string, text: string) => {
    bad[path] = Object.hasOwn(bad, path) ? `${bad[path]} ${text}` : text;
  };
  try {
    return check(input, options?.allowReversal === true, bad, flag);
  } catch {
    // A hostile object (a throwing getter or proxy) must not escape: fail closed (R16).
    return { ok: false, error: "validation", fields: { input: "The request could not be read." } };
  }
}

function check(
  input: unknown,
  allowReversal: boolean,
  bad: Record<string, string>,
  flag: (path: string, text: string) => void,
): CheckedPosting {
  if (!isObject(input)) {
    return { ok: false, error: "validation", fields: { input: "The request must be an object." } };
  }

  // kind
  let kind: LedgerKind | null = null;
  if (!KINDS.includes(input.kind)) {
    flag("kind", "The kind is not known.");
  } else if (input.kind === "reversal" && !allowReversal) {
    flag("kind", "A reversal is posted by the reversal function only.");
  } else {
    kind = input.kind as LedgerKind;
  }

  // reference
  const reference = isObject(input.reference) ? input.reference : {};
  const referenceType = reference.type;
  if (typeof referenceType !== "string" || !REFERENCE_TYPE.test(referenceType)) {
    flag("reference.type", "The reference type must be a lower case word.");
  }
  const referenceId = reference.id;
  if (!isUuid(referenceId)) flag("reference.id", "The reference id must be a UUID.");

  // idempotency key
  const key = input.idempotencyKey;
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH || !KEY.test(key)) {
    flag(
      "idempotencyKey",
      `The key must be 1 to ${MAX_KEY_LENGTH} printable ASCII characters without a space.`,
    );
  }

  // actor
  let actor: NormalizedPosting["actor"] | null = null;
  const rawActor = input.actor;
  if (isObject(rawActor)) {
    if (rawActor.type === "system" && rawActor.id === undefined) {
      actor = { type: "system", id: null };
    } else if ((rawActor.type === "customer" || rawActor.type === "admin") && isUuid(rawActor.id)) {
      actor = { type: rawActor.type, id: rawActor.id.toLowerCase() };
    }
  }
  if (actor === null) {
    flag("actor", "The actor must be the system, or a customer or an admin with a UUID.");
  }

  // memo
  let memo: string | null = null;
  if (input.memo !== undefined) {
    const trimmed = typeof input.memo === "string" ? input.memo.trim() : "";
    if (trimmed.length < 1 || trimmed.length > MAX_MEMO_LENGTH) {
      flag("memo", `The memo must be 1 to ${MAX_MEMO_LENGTH} characters.`);
    } else {
      memo = trimmed;
    }
  }

  // postings: every line first, the rules across the lines only when every line is valid
  const postings = input.postings;
  const lines: NormalizedLine[] = [];
  let linesValid = false;
  if (!Array.isArray(postings) || postings.length > MAX_POSTINGS) {
    flag("postings", `The postings must be an array of 2 to ${MAX_POSTINGS} items.`);
  } else {
    if (postings.length < 2) {
      flag("postings", `The postings must be an array of 2 to ${MAX_POSTINGS} items.`);
    }
    linesValid = true;
    postings.forEach((raw: unknown, i: number) => {
      const line = parseLine(raw, `postings[${i}]`, flag);
      if (line === null) linesValid = false;
      else lines.push(line);
    });
  }

  let currency: string = LEDGER_CURRENCY;
  let walletCustomerId: string | null = null;
  let walletDelta = 0n;
  if (linesValid && lines.length > 0) {
    currency = lines[0]!.account.currency;
    let sameCurrency = true;
    const seen = new Set<string>();
    let debits = 0n;
    let credits = 0n;
    let wallets = 0;
    lines.forEach((line, j) => {
      if (line.account.currency !== currency) {
        sameCurrency = false;
        flag(`postings[${j}].account.currency`, "All postings must use the currency of the first.");
      }
      const id = `${line.account.type}|${line.account.customerId ?? ""}|${line.account.currency}`;
      if (seen.has(id)) flag(`postings[${j}]`, "An account may appear once in a request.");
      seen.add(id);
      if (line.direction === "debit") debits += line.amountMinor;
      else credits += line.amountMinor;
      if (line.account.type === "customer_wallet") {
        wallets += 1;
        walletCustomerId = line.account.customerId;
        walletDelta = line.direction === "credit" ? line.amountMinor : -line.amountMinor;
      }
    });
    if (wallets > 1) flag("postings", "A request may name one customer wallet at most.");
    if (!lines.some((l) => l.direction === "debit")) flag("postings", "There must be a debit.");
    if (!lines.some((l) => l.direction === "credit")) flag("postings", "There must be a credit.");
    if (sameCurrency && debits !== credits) flag("postings", "Debits and credits must be equal.");
    if (wallets > 1) {
      walletCustomerId = null;
      walletDelta = 0n;
    }
  }

  // The rules of the kind (9.1): reference type, key family, reason and lines. They are shape problems,
  // so they all come before the permission step.
  if (kind !== null) {
    const rule = KIND_RULES[kind];
    if (
      rule.referenceType !== null &&
      typeof referenceType === "string" &&
      REFERENCE_TYPE.test(referenceType) &&
      referenceType !== rule.referenceType
    ) {
      flag("reference.type", "The reference type is not the one of this kind.");
    }
    if (
      isUuid(referenceId) &&
      !Object.hasOwn(bad, "idempotencyKey") &&
      !rule.keyOk(key as string, referenceId.toLowerCase())
    ) {
      flag("idempotencyKey", "The key is not of the key family of this kind.");
    }
    if (
      actor !== null &&
      memo === null &&
      !Object.hasOwn(bad, "memo") &&
      rule.memoRequiredFor.includes(actor.type)
    ) {
      flag("memo", "This posting needs a reason.");
    }
    if (linesValid) checkShape(rule.shape, lines, flag);
  }

  if (Object.keys(bad).length > 0 || kind === null || actor === null) {
    return { ok: false, error: "validation", fields: bad };
  }

  // Who may post (R6, R8). Only when nothing else is wrong, so a shape problem always wins.
  const forbidden: Record<string, string> = {};
  if (!KIND_RULES[kind].actors.includes(actor.type)) {
    forbidden.actor = "This actor may not post this kind.";
  }
  if (actor.type === "customer") {
    lines.forEach((line, i) => {
      if (line.account.type === "customer_wallet" && line.account.customerId !== actor.id) {
        forbidden[`postings[${i}].account.customerId`] =
          "A customer may post to its own wallet only.";
      }
    });
  }
  if (Object.keys(forbidden).length > 0) {
    return { ok: false, error: "forbidden", fields: forbidden };
  }
  return {
    ok: true,
    value: {
      kind,
      referenceType: referenceType as string,
      referenceId: (referenceId as string).toLowerCase(),
      idempotencyKey: key as string,
      actor,
      memo,
      currency,
      lines,
      walletCustomerId,
      walletDelta,
    },
  };
}

/** The lines of a kind (9.1). One problem at `postings`, and one at `postings[i]` per credit line that is not allowed. */
function checkShape(
  shape: Shape,
  lines: readonly NormalizedLine[],
  flag: (path: string, text: string) => void,
): void {
  if (shape === "free") return;
  const debits = lines.filter((l) => l.direction === "debit");
  const credits = lines.filter((l) => l.direction === "credit");
  let wrong: boolean;
  if ("pairs" in shape) {
    const debit = debits[0];
    const credit = credits[0];
    wrong =
      lines.length !== 2 ||
      debit === undefined ||
      credit === undefined ||
      debits.length !== 1 ||
      !shape.pairs.some(([d, c]) => d === debit.account.type && c === credit.account.type);
  } else {
    wrong = debits.length !== 1 || debits[0]!.account.type !== shape.debit;
    lines.forEach((line, i) => {
      if (line.direction === "credit" && !shape.credits.includes(line.account.type)) {
        flag(`postings[${i}]`, "This account may not be credited by this kind.");
      }
    });
    for (const type of shape.required) {
      if (credits.filter((l) => l.account.type === type).length !== 1) wrong = true;
    }
  }
  if (wrong) flag("postings", "The postings are not the lines of this kind.");
}

/**
 * The postings of the reversing transaction (R5): for each line, in the same order, the same account
 * (its currency written out), the other side and the same amount.
 */
export function reversePostings(lines: readonly NormalizedLine[]): Posting[] {
  return lines.map((line): Posting => {
    const { type, customerId, currency } = line.account;
    let account: LedgerAccountRef;
    if (type === "customer_wallet") {
      if (customerId === null)
        throw new TypeError("reversePostings: a wallet line has no customer");
      account = { type, customerId, currency };
    } else {
      account = { type, currency };
    }
    return {
      account,
      direction: line.direction === "debit" ? "credit" : "debit",
      amountMinor: line.amountMinor,
    };
  });
}

export interface StoredPosting {
  readonly kind: string;
  readonly referenceType: string;
  readonly referenceId: string;
  readonly lines: readonly {
    accountId: string;
    direction: "debit" | "credit";
    amountMinor: bigint;
  }[];
}

/**
 * True when the stored transaction and the wanted one are the same request: same kind and reference,
 * and the same lines as a multiset of (account, side, amount). The actor and the memo are not compared.
 */
export function samePosting(stored: StoredPosting, wanted: StoredPosting): boolean {
  if (
    stored.kind !== wanted.kind ||
    stored.referenceType !== wanted.referenceType ||
    stored.referenceId !== wanted.referenceId ||
    stored.lines.length !== wanted.lines.length
  ) {
    return false;
  }
  const count = new Map<string, number>();
  const id = (l: StoredPosting["lines"][number]) =>
    JSON.stringify([l.accountId, l.direction, l.amountMinor.toString()]);
  for (const l of stored.lines) count.set(id(l), (count.get(id(l)) ?? 0) + 1);
  for (const l of wanted.lines) {
    const n = count.get(id(l)) ?? 0;
    if (n === 0) return false;
    count.set(id(l), n - 1);
  }
  return true;
}

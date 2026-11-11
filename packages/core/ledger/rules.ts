import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_CURRENCY,
  LEDGER_KINDS,
  MAX_KEY_LENGTH,
  MAX_MEMO_LENGTH,
  MAX_MINOR,
  MAX_POSTINGS,
  type LedgerAccountType,
  type LedgerKind,
} from "./types";
import { isUuid } from "./uuid";

// Spec 9.1 and open point 5: the check of a posting request, part one (shape, amounts, currency, balance).
// Pure: no database, no clock, no throw. A text of a problem is a constant of this file, never built
// from the input (R14), and an amount is compared as a bigint only after `typeof` said it is one (R4).

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

  if (Object.keys(bad).length > 0 || kind === null || actor === null) {
    return { ok: false, error: "validation", fields: bad };
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

import type {
  AdminActor,
  AdminRepos,
  DiscrepancyRow,
  PaymentAdminDetail,
  PaymentFilter,
  PaymentSearchResult,
  WalletAdminDetail,
} from "@tc/db";
import { PAYMENT_STATUSES } from "@tc/db";
import { readAsAdmin } from "./runtime.ts";

// The reads of the money screens (R9 steps 1 and 2 were done by loadPageAdmin; the repository checks
// the role again). A refusal or a failing database gives a fixed state, never the text of an error
// (R14, R16).
export type Loaded<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

async function read<T>(
  admin: AdminActor,
  fn: (repos: AdminRepos) => Promise<Answer<T>>,
): Promise<Loaded<T>> {
  try {
    const out = await readAsAdmin(admin, fn);
    if (out.ok) return { kind: "ok", value: out.value };
    return out.error === "not_found" ? { kind: "missing" } : { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface PaymentQuery {
  readonly q: string;
  readonly status: PaymentFilter | null;
  readonly after: string | null;
}

export const loadWallet = (admin: AdminActor, customerId: string, cursor: string | null) =>
  read<WalletAdminDetail>(admin, (repos) =>
    repos.wallets.detail(customerId, cursor === null ? {} : { cursor }),
  );

export const loadPayments = (admin: AdminActor, query: PaymentQuery) =>
  read<PaymentSearchResult>(admin, (repos) =>
    repos.payments.search({
      ...(query.q === "" ? {} : { q: query.q }),
      ...(query.status === null ? {} : { status: query.status }),
      ...(query.after === null ? {} : { after: query.after }),
    }),
  );

export const loadPayment = (admin: AdminActor, id: string) =>
  read<PaymentAdminDetail>(admin, (repos) => repos.payments.detail(id));

export const loadOpenDiscrepancies = (admin: AdminActor) =>
  read<DiscrepancyRow[]>(admin, (repos) =>
    repos.payments.discrepancies({ kind: "payment", status: "open", limit: 50 }),
  );

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR = /^[0-9]{10,16}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

// The query of the payments page, from the URL: a value that is not one of ours is dropped.
export function paymentQueryOf(raw: Record<string, string | string[] | undefined>): PaymentQuery {
  const status = one(raw["status"]);
  const after = one(raw["after"]);
  const known = status === "pending" || (PAYMENT_STATUSES as readonly string[]).includes(status);
  return {
    q: one(raw["q"]).trim().slice(0, 100),
    status: known ? (status as PaymentFilter) : null,
    after: UUID.test(after) ? after : null,
  };
}

export const cursorOf = (raw: Record<string, string | string[] | undefined>): string | null => {
  const cursor = one(raw["cursor"]);
  return CURSOR.test(cursor) ? cursor : null;
};

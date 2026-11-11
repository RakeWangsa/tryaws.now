import type {
  AdminActor,
  AdminRepos,
  CustomerDetail,
  CustomerSearchResult,
  KycQueueRow,
} from "@tc/db";
import { readAsAdmin } from "./runtime.ts";

// The reads of the customer screens (R9 steps 1 and 2 were done by loadPageAdmin; the repository checks
// the role again). A refusal or a failing database gives a fixed state, never the text of an error
// (R14, R16).
export type Loaded<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable" };

export interface ListQuery {
  readonly q: string;
  readonly kyc: "none" | "pending" | "verified" | "rejected" | null;
  readonly after: string | null;
}

type Answer<T> = { ok: true; value: T } | { ok: false; error: string };

export async function read<T>(
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

export const loadCustomerList = (admin: AdminActor, query: ListQuery) =>
  read<CustomerSearchResult>(admin, (repos) =>
    repos.customers.search({
      ...(query.q === "" ? {} : { q: query.q }),
      ...(query.kyc === null ? {} : { kycStatus: query.kyc }),
      ...(query.after === null ? {} : { after: query.after }),
    }),
  );

export const loadCustomerDetail = (admin: AdminActor, id: string) =>
  read<CustomerDetail>(admin, (repos) => repos.customers.detail(id));

export const loadKycQueue = (admin: AdminActor) =>
  read<KycQueueRow[]>(admin, (repos) => repos.customers.kycQueue({ limit: 50 }));

const KYC = ["none", "pending", "verified", "rejected"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

// The query of the page, from the URL: a value that is not one of ours is dropped, never passed on.
export function queryOf(raw: Record<string, string | string[] | undefined>): ListQuery {
  const kyc = one(raw["kyc"]);
  const after = one(raw["after"]);
  return {
    q: one(raw["q"]).trim().slice(0, 100),
    kyc: (KYC as readonly string[]).includes(kyc) ? (kyc as ListQuery["kyc"]) : null,
    after: UUID.test(after) ? after : null,
  };
}

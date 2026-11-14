import type { CustomerSession } from "@tc/auth";
import {
  DOMAIN_FLAG,
  decideTld,
  normalizeDomainName,
  pricingInForce,
  quoteWithBook,
  type TldDecision,
} from "@tc/core";
import { customerRepos, listTlds, readFeatureFlag, withTx } from "@tc/db";
import type { Tx } from "@tc/db";
import { accountSetupGate, type AccountSetupRequired } from "./account-setup.ts";

// What the domain screens show (WP7-T4, 16.10), read through the repositories of the session's customer
// (R8). A database error is thrown, never answered with an empty list (R16). Nothing here returns an
// AWS account id, an ARN, a generated AWS name or an error text of AWS (U6, R11), the operation id of
// Route 53, the hosted zone id or the registrant contact: the resource config is read field by field.

export type Availability = "available" | "unavailable" | "premium" | "unknown";

/** The search port: the reader function `checkDomain(name)` (F). It reads no customer data. */
export interface DomainSearchPort {
  check(name: string): Promise<Availability>;
}

export interface TldOption {
  tld: string;
  decision: Exclude<TldDecision, "unavailable">;
  /** The price of one year in paisa, from the pricing engine (R4). */
  priceMinor: bigint;
}

export type DomainSearchScreen =
  | { state: "flag_off" }
  | { state: "idle"; tlds: TldOption[] }
  | { state: "invalid"; tlds: TldOption[] }
  | { state: "search_unavailable"; tlds: TldOption[] }
  | {
      state: "result";
      name: string;
      tld: string;
      availability: Availability;
      decision: Exclude<TldDecision, "unavailable">;
      priceMinor: bigint;
      tlds: TldOption[];
    };

/** The sellable TLDs with a price of the day. No rate or rule in force: nothing is priced (R16). */
async function priceTlds(tx: Tx, market: string, now: () => Date) {
  const rows = await listTlds(tx);
  const found = await pricingInForce(tx, { market, productFamily: DOMAIN_FLAG }, { now });
  if (!found.ok) throw new Error("domains: no rate or rule in force");
  const options: (TldOption & { id: string })[] = [];
  for (const row of rows) {
    const decision = decideTld(row);
    if (decision === "unavailable" || row.registrationPriceUsd === null) continue;
    // The same price as the order: the rule and the margin of the family (WPA-P1).
    const priced = quoteWithBook(
      {
        awsPriceUsd: row.registrationPriceUsd,
        quantity: "1",
        fxRate: found.value.fx.rate,
        rule: found.value.rule.value,
      },
      found.value.book,
    ).quote;
    options.push({ id: row.id, tld: row.tld, decision, priceMinor: priced.totalMinor });
  }
  return options;
}

const strip = (options: readonly (TldOption & { id: string })[]): TldOption[] =>
  options.map(({ tld, decision, priceMinor }) => ({ tld, decision, priceMinor }));

export async function loadDomainSearch(
  session: CustomerSession,
  rawQuery: string | undefined,
  search: DomainSearchPort | null,
  now: () => Date,
): Promise<DomainSearchScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("domains: no customer row");
    // R12, R16: a flag that is off or unreadable shows the flag-off state.
    if ((await readFeatureFlag(tx, DOMAIN_FLAG, profile.market)) !== true) {
      return { state: "flag_off" };
    }
    const priced = await priceTlds(tx, profile.market, now);
    const tlds = strip(priced);
    if (rawQuery === undefined || rawQuery.trim() === "") return { state: "idle", tlds };
    const name = normalizeDomainName(
      rawQuery,
      priced.map((o) => o.tld),
    );
    if (!name.ok) return { state: "invalid", tlds };
    if (search === null) return { state: "search_unavailable", tlds };
    let availability: Availability;
    try {
      availability = await search.check(name.value.name);
    } catch {
      return { state: "search_unavailable", tlds };
    }
    const option = priced.find((o) => o.tld === name.value.tld);
    if (option === undefined) return { state: "invalid", tlds };
    return {
      state: "result",
      name: name.value.name,
      tld: name.value.tld,
      availability,
      decision: option.decision,
      priceMinor: option.priceMinor,
      tlds,
    };
  });
}

export type DomainOrderScreen =
  | { state: "flag_off" }
  | AccountSetupRequired
  | { state: "invalid" }
  | {
      state: "ready";
      name: string;
      tld: string;
      productId: string;
      priceMinor: bigint;
      review: boolean;
    };

/** /domains/new?name=: the name and its price for the contact form and the confirmation. */
export async function loadDomainOrder(
  session: CustomerSession,
  rawName: string | undefined,
  now: () => Date,
): Promise<DomainOrderScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("domains: no customer row");
    if ((await readFeatureFlag(tx, DOMAIN_FLAG, profile.market)) !== true) {
      return { state: "flag_off" };
    }
    // WPU-X11: e-mail, mobile and authenticator, the same predicate as the purchase gate (not KYC).
    const setup = accountSetupGate(profile);
    if (setup !== null) return setup;
    const priced = await priceTlds(tx, profile.market, now);
    const name = normalizeDomainName(
      rawName,
      priced.map((o) => o.tld),
    );
    if (!name.ok) return { state: "invalid" };
    const option = priced.find((o) => o.tld === name.value.tld);
    if (option === undefined) return { state: "invalid" };
    return {
      state: "ready",
      name: name.value.name,
      tld: name.value.tld,
      productId: option.id,
      priceMinor: option.priceMinor,
      review: option.decision === "review",
    };
  });
}

export interface DomainRowView {
  name: string;
  state: string;
  expiresAt: Date | null;
}

export type DomainListScreen = { state: "flag_off" } | { state: "ready"; items: DomainRowView[] };

/** The registration state of the screens: the config of the resource says more than the first row. */
export function domainStateOf(resourceState: string, config: unknown, rowStatus: string): string {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  if (resourceState === "failed") return "failed";
  const status = raw["domainStatus"];
  if (status === "registered" || status === "awaiting_verification") return status;
  return rowStatus === "review" ? "review" : "pending";
}

export async function loadDomainList(session: CustomerSession): Promise<DomainListScreen> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("domains: no customer row");
    if ((await readFeatureFlag(tx, DOMAIN_FLAG, profile.market)) !== true) {
      return { state: "flag_off" };
    }
    const rows = await repos.domains.list();
    const resources = new Map((await repos.resources.list()).map((r) => [r.id, r]));
    const items = rows.map((row): DomainRowView => {
      const resource = resources.get(row.resourceId);
      return {
        name: row.name,
        state: domainStateOf(resource?.state ?? "failed", resource?.config, row.status),
        expiresAt: expiryOf(resource?.config) ?? row.expiresAt,
      };
    });
    return { state: "ready", items };
  });
}

function expiryOf(config: unknown): Date | null {
  const raw =
    typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const text = raw["expiresAt"];
  if (typeof text !== "string") return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface DomainDetailView extends DomainRowView {
  resourceId: string;
  tld: string;
  /** The registrant's e-mail check (ICANN): until it is done the registry may suspend the name. */
  reachability: "pending" | "done" | "expired" | "unknown";
  nameServers: string[];
  autoRenew: boolean;
  periodEnd: Date | null;
  createdAt: Date;
}

export async function loadDomainDetail(
  session: CustomerSession,
  name: string,
): Promise<DomainDetailView | null> {
  return withTx(async (tx) => {
    const repos = customerRepos(tx, session.customerId);
    const profile = await repos.profile.get();
    if (profile === null) throw new Error("domains: no customer row");
    // R12, R16: with the flag off the page answers like a missing one.
    if ((await readFeatureFlag(tx, DOMAIN_FLAG, profile.market)) !== true) return null;
    // null for a missing row and for another customer's row alike (R8).
    const row = await repos.domains.getByName(name);
    if (row === null) return null;
    const resource = await repos.resources.get(row.resourceId);
    const subscription = await repos.subscriptions.get(row.resourceId);
    const raw =
      typeof resource?.config === "object" && resource.config !== null
        ? (resource.config as Record<string, unknown>)
        : {};
    const reach = raw["reachability"];
    const servers = raw["nameServers"];
    return {
      resourceId: row.resourceId,
      name: row.name,
      tld: row.tld,
      state: domainStateOf(resource?.state ?? "failed", resource?.config, row.status),
      expiresAt: expiryOf(resource?.config) ?? row.expiresAt,
      reachability:
        reach === "pending" || reach === "done" || reach === "expired" ? reach : "unknown",
      nameServers: Array.isArray(servers)
        ? servers
            .filter((s): s is string => typeof s === "string" && /^[a-z0-9.-]{1,253}$/i.test(s))
            .slice(0, 8)
        : [],
      autoRenew: subscription?.autoRenew ?? false,
      periodEnd: subscription?.periodEnd ?? null,
      createdAt: row.createdAt,
    };
  });
}

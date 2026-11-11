import { requireCustomer } from "@tc/auth";
import type { CustomerSession } from "@tc/auth";
import { customerRepos, readFeatureFlags, readMarketBasics, withTx } from "@tc/db";
import type { ProductFamily } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { getLocale } from "next-intl/server";
import { redirect } from "next/navigation";
import { cache } from "react";
import { enabledFamilies } from "./families.ts";
import { writeLog } from "./log.ts";
import { requestId, safeNext } from "./request.ts";

// What every page of the signed-in panel needs: the session, the name for the account menu, the
// balance for the top bar and the families that are on. It is read once per request (`cache`), and
// it is the one place that turns "no session" into the login redirect (open point 3). WP2-T2 builds
// the real /login; until then the URL is a 404.

export interface PanelData {
  session: CustomerSession;
  /** Empty when the customer has not given a name yet; the shell then shows its own label. */
  displayName: string;
  balanceMinor: bigint;
  market: { code: string; numerals: "beng" | "latn" };
  enabledFamilies: ProductFamily[];
  soonFamilies: ProductFamily[];
}

export type PanelOutcome =
  { ok: true; data: PanelData } | { ok: false; redirectTo: string; locale: Locale };

/** "/login?next=<path>" in the locale of the request; `next` is dropped when it is not on the allow-list (U12). */
export function loginRedirect(locale: Locale, path: string): string {
  const next = safeNext(path);
  const base = localePath(locale, "/login");
  return next === null ? base : `${base}?next=${encodeURIComponent(next)}`;
}

async function localeOfRequest(): Promise<Locale> {
  try {
    const found = await getLocale();
    return found === "en" ? "en" : "bn";
  } catch {
    return "bn";
  }
}

async function load(path: string): Promise<PanelOutcome> {
  const locale = await localeOfRequest();
  const refuse = (): PanelOutcome => ({
    ok: false,
    redirectTo: loginRedirect(locale, path),
    locale,
  });

  let session: CustomerSession;
  try {
    session = await requireCustomer();
  } catch {
    return refuse();
  }

  try {
    return await withTx(async (tx) => {
      const repos = customerRepos(tx, session.customerId);
      const [profile, wallet] = await Promise.all([repos.profile.get(), repos.wallet.view()]);
      // A session without a customer row cannot happen after requireCustomer; refuse if it does (R16).
      if (profile === null) return refuse();
      const [market, flags] = await Promise.all([
        readMarketBasics(tx, profile.market),
        readFeatureFlags(tx, profile.market),
      ]);
      if (market === null) return refuse();
      const data: PanelData = {
        session,
        displayName: profile.name ?? "",
        balanceMinor: wallet?.balanceMinor ?? 0n,
        market: { code: market.code, numerals: market.numerals },
        enabledFamilies: enabledFamilies(flags),
        soonFamilies: [],
      };
      return { ok: true, data } satisfies PanelOutcome;
    });
  } catch {
    // The database could not be read: never show a balance of zero instead (R16).
    writeLog({ event: "panel.load", reason: "unavailable", requestId: requestId() });
    return refuse();
  }
}

const loadCached = cache(load);

/** Once per request for a path; `path` is only used to build the `next` of the login redirect. */
export function loadPanel(path = "/dashboard"): Promise<PanelOutcome> {
  return loadCached(path);
}

/** The first line of every page of the panel: the data, or a redirect to the login (never an empty page). */
export async function requirePanel(path: string): Promise<PanelData> {
  const outcome = await loadPanel(path);
  if (!outcome.ok) redirect(outcome.redirectTo);
  return outcome.data;
}

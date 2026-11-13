import { adminRepos, readMarkets, type AdminActor, type AuditRow, type SellerRow } from "@tc/db";
import { getterOf, type Loaded, type Raw } from "./pricing-data.ts";
import { readTx } from "./pricing-runtime.ts";

// The reads of /pricing/seller (WPU-I1): the seller of the tax invoices for a market, and the audit rows of
// its changes (the versions). A refusal or a failing database gives a fixed state, never the text of an
// error (R14, R16). The loader takes the actor first: every repository read checks the role again.
// `missing` and `invalid` both mean that no invoice is issued or printed for this market.

export interface SellerHistoryLine {
  readonly row: AuditRow;
  /** The NAMES of the fields that this save changed (never their values). */
  readonly changed: readonly string[];
}

export interface InvoiceSellerScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly state: "missing" | "invalid" | "ready";
  readonly seller: SellerRow | null;
  readonly version: number | null;
  readonly history: readonly SellerHistoryLine[];
  /** WPU-I2: charges that wait for an invoice because the seller details were missing. */
  readonly backlog: { readonly count: number; readonly oldest: Date | null };
}

const DEFAULT_MARKET = "BD";
const HISTORY_ROWS = 20;
const SEARCH_ROWS = 100;
const MARKET = /^[A-Z]{2}$/;
const FIELDS = [
  "legalNameBn",
  "legalNameEn",
  "bin",
  "addressBn",
  "addressEn",
  "vatCircle",
  "tradeLicense",
  "signatoryName",
  "signatoryDesignation",
  "phone",
  "email",
] as const;

function changedFields(before: unknown, after: unknown): string[] {
  const get = (v: unknown, k: string): unknown =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
  return FIELDS.filter((k) => get(before, k) !== get(after, k));
}

export async function loadInvoiceSeller(
  admin: AdminActor,
  raw: Raw,
): Promise<Loaded<InvoiceSellerScreen>> {
  const get = getterOf(raw);
  const asked = MARKET.test(get("market").trim()) ? get("market").trim() : DEFAULT_MARKET;
  try {
    const value = await readTx(async (tx): Promise<InvoiceSellerScreen> => {
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(asked) ? asked : (markets[0] ?? asked);
      const repos = adminRepos(tx, admin);
      // A refused read (a role the repository does not serve) is an unavailable screen, not an empty one.
      const stored = await repos.invoiceSeller.read(market);
      if (!stored.ok) throw new Error("invoice seller: the read was refused");
      // A refused or failed count is an unavailable screen, not "nothing waits" (R16).
      const waiting = await repos.invoiceSeller.backlog(market);
      if (!waiting.ok) throw new Error("invoice seller: the backlog read was refused");
      const backlog = { count: waiting.value.count, oldest: waiting.value.oldest };
      const found = await repos.audit.search({
        action: "invoice_seller.save",
        targetType: "invoice_seller",
        limit: SEARCH_ROWS,
      });
      const history: SellerHistoryLine[] = found.ok
        ? found.value.rows
            .filter((r) => r.targetId === market)
            .slice(0, HISTORY_ROWS)
            .map((row) => ({ row, changed: changedFields(row.before, row.after) }))
        : [];
      const s = stored.value;
      if (s.state === "none") {
        return { markets, market, state: "missing", seller: null, version: null, history, backlog };
      }
      if (s.state === "invalid") {
        return { markets, market, state: "invalid", seller: null, version: null, history, backlog };
      }
      return {
        markets,
        market,
        state: "ready",
        seller: s.seller,
        version: s.version,
        history,
        backlog,
      };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}

import {
  BLUEPRINT_FAMILY,
  isImageOn,
  listFeatureFlags,
  minPowerOf,
  optionOf,
  pricingInForce,
  previewChange,
  priceCatalog,
  fxRateAgeSeconds,
  fxRateState,
  type FlagState,
  type FxRateState,
  type PreviewRow,
  type PricedCatalogRow,
  type PricingStep,
} from "@tc/core";
import {
  adminRepos,
  listCatalogProductsForAdmin,
  listImagesForAdmin,
  readImageSwitches,
  readFxRateInForce,
  readFxRates,
  readMarkets,
  readPricingRules,
  type AdminActor,
  type CatalogAdminRow,
  type FxChange,
  type FxRateRow,
  type PricingRuleRow,
} from "@tc/db";
import { readDraft, wantsPreview, type Draft, type Getter } from "./pricing-draft.ts";
import { readTx } from "./pricing-runtime.ts";

// The reads of /pricing and /catalog. A refusal or a failing database gives a fixed state, never the text
// of an error (R14, R16). Money stays bigint paisa in a PriceQuote and decimal text elsewhere (R4).

export type Raw = Record<string, string | string[] | undefined>;

export const getterOf =
  (raw: Raw): Getter =>
  (name) => {
    const value = raw[name];
    return typeof value === "string" ? value : "";
  };

export type Loaded<T> =
  { readonly kind: "ok"; readonly value: T } | { readonly kind: "unavailable" };

export type PreviewState =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly rows: readonly PreviewRow[] }
  | { readonly kind: "invalid"; readonly fields: readonly string[] }
  | { readonly kind: "unavailable" };

export interface PricingScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly draft: Draft;
  // True when the draft came from the query (the editor was submitted), false when it is the rule in force.
  readonly submitted: boolean;
  readonly rules: readonly PricingRuleRow[];
  readonly fxHistory: readonly FxRateRow[];
  readonly fxInForce: FxRateRow | null;
  // WPU-Y1. Who saved the rate in force and when, and its state at `now` (missing, fresh, ageing after 6 days,
  // stale after 7 days). `setBy` is an admin id; the screen shows its first 8 characters only.
  readonly fxMeta?: { readonly setBy: string | null; readonly setAt: Date } | null;
  readonly fxState?: FxRateState;
  readonly fxAgeSeconds?: number | null;
  readonly pending: FxChange | null;
  readonly preview: PreviewState;
  readonly now: Date;
}

const DEFAULT_MARKET = "BD";

function stepsOf(draft: Draft): PricingStep[] | null {
  const out: PricingStep[] = [];
  for (const s of draft.steps) {
    if (s.base !== "aws" && s.base !== "subtotal") return null;
    out.push({ code: s.code, rate: s.rate, base: s.base, label: { bn: s.bn, en: s.en } });
  }
  return out;
}

const draftOfSteps = (steps: readonly PricingStep[]): Draft["steps"] =>
  steps.map((s) => ({
    code: s.code,
    rate: s.rate,
    base: s.base,
    bn: s.label.bn,
    en: s.label.en,
  }));

export async function loadPricing(
  admin: AdminActor,
  raw: Raw,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<Loaded<PricingScreen>> {
  const get = getterOf(raw);
  const asked = readDraft(get, DEFAULT_MARKET);
  const submitted = wantsPreview(get);
  try {
    const value = await readTx(async (tx): Promise<PricingScreen> => {
      const now = clock.now();
      const once = { now: () => now };
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(asked.market) ? asked.market : (markets[0] ?? asked.market);
      const [rules, fxHistory, fxInForce, pending, fxMeta] = await Promise.all([
        readPricingRules(tx, market, 50),
        readFxRates(tx, market, 50),
        readFxRateInForce(tx, market, now),
        adminRepos(tx, admin).fxChanges.read(market),
        adminRepos(tx, admin).fxRates.meta(market, now),
      ]);
      const anchor = fxInForce === null ? null : fxInForce.createdAt; // WPU-Y9: the age counts from the entry
      let draft: Draft = { ...asked, market };
      let preview: PreviewState = { kind: "none" };
      if (submitted) {
        const steps = stepsOf(draft);
        if (steps === null) {
          preview = { kind: "invalid", fields: ["steps"] };
        } else {
          const shown = await previewChange(
            tx,
            {
              market,
              productFamily: draft.family,
              ...(draft.fx === "" ? {} : { fxRate: draft.fx }),
              ...(steps.length === 0 ? {} : { steps }),
            },
            once,
          );
          preview = shown.ok
            ? { kind: "ok", rows: shown.value.rows }
            : shown.error === "validation"
              ? { kind: "invalid", fields: Object.keys(shown.fields ?? {}).slice(0, 8) }
              : { kind: "unavailable" };
        }
      } else {
        // The editor opens on the rule in force for the family, or the rule of the market.
        const found = await pricingInForce(tx, { market, productFamily: draft.family }, once, {
          allowStale: true,
        });
        if (found.ok) draft = { ...draft, steps: draftOfSteps(found.value.rule.value.steps) };
      }
      return {
        markets,
        market,
        draft,
        submitted,
        rules,
        fxHistory,
        fxInForce,
        fxMeta: fxMeta === null ? null : { setBy: fxMeta.setBy, setAt: fxMeta.setAt },
        fxState: fxRateState(anchor, now),
        fxAgeSeconds: fxRateAgeSeconds(anchor, now),
        pending,
        preview,
        now,
      };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface CatalogFamily {
  readonly family: string;
  readonly flag: string;
  readonly enabled: boolean;
  readonly lastSyncedAt: Date | null;
  readonly rows: readonly {
    readonly row: CatalogAdminRow;
    // null: no rate or rule is in force for this family in the market, so no price is shown (R16).
    readonly price: PricedCatalogRow | null;
  }[];
}

/** One image (WPU-G3) as the allow-list card shows it: AWS facts, the Regions where it is active, the switch. */
export interface ImageAdminRow {
  readonly id: string;
  readonly name: string;
  readonly kind: "app" | "os";
  readonly loginUser: string | null;
  /** The Regions where AWS lists it as active. */
  readonly regions: readonly string[];
  /** On for customers of the market: an explicit switch, else the default list. */
  readonly on: boolean;
  /** True when an admin has switched it; false when it follows the default list. */
  readonly explicit: boolean;
  /**
   * WPU-G10. The least bundle power a plan needs to run it (500 is the 1 GB plan, 298 the 512 MB plan; WPU-Z19): the value in force,
   * where it comes from (the admin's override, what AWS reported, or the default of the core), and the
   * admin's own value when there is one.
   */
  readonly minPower: number;
  readonly minPowerBy: "admin" | "aws" | "default";
  readonly minPowerAdmin: number | null;
}

export interface CatalogScreen {
  readonly markets: readonly string[];
  readonly market: string;
  readonly flags: readonly FlagState[];
  readonly families: readonly CatalogFamily[];
  readonly images: readonly ImageAdminRow[];
  /** A stored allow-list that does not parse: nothing is offered until an admin saves a switch. */
  readonly imagesInvalid: boolean;
}

export async function loadCatalog(
  _admin: AdminActor,
  raw: Raw,
  clock: { now(): Date } = { now: () => new Date() },
): Promise<Loaded<CatalogScreen>> {
  const asked = getterOf(raw)("market").trim();
  try {
    const value = await readTx(async (tx): Promise<CatalogScreen> => {
      const now = clock.now();
      const markets = (await readMarkets(tx)).map((m) => m.code);
      const market = markets.includes(asked) ? asked : (markets[0] ?? DEFAULT_MARKET);
      const flags = await listFeatureFlags(tx, market);
      // The images are rows of the same table (family `blueprint`) but have no price: their own card.
      const rows = (await listCatalogProductsForAdmin(tx, {})).filter(
        (r) => r.family !== BLUEPRINT_FAMILY,
      );
      const stored = await readImageSwitches(tx, market);
      const switches = stored.state === "ok" ? stored.switches : { on: [], off: [] };
      const byImage = new Map<string, ImageAdminRow>();
      for (const row of await listImagesForAdmin(tx)) {
        const option = optionOf(row);
        if (option === null) continue;
        const seen = byImage.get(option.id);
        const regions = [...(seen?.regions ?? []), ...(row.active ? [row.region] : [])];
        byImage.set(option.id, {
          id: option.id,
          name: option.name,
          kind: option.kind,
          loginUser: option.loginUser,
          regions,
          on: stored.state !== "invalid" && isImageOn(switches, option.id),
          explicit: switches.on.includes(option.id) || switches.off.includes(option.id),
          minPower: minPowerOf(option, switches),
          minPowerBy:
            switches.minPower?.[option.id] !== undefined
              ? "admin"
              : option.minPower !== null
                ? "aws"
                : "default",
          minPowerAdmin: switches.minPower?.[option.id] ?? null,
        });
      }
      const images = [...byImage.values()].sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "app" ? -1 : 1,
      );
      const byFamily = new Map<string, CatalogAdminRow[]>();
      for (const row of rows) byFamily.set(row.family, [...(byFamily.get(row.family) ?? []), row]);
      const families: CatalogFamily[] = [];
      for (const [family, list] of byFamily) {
        const priced = await priceCatalog(
          tx,
          list,
          { market, includeInactive: true },
          { now: () => now },
        );
        const byId = new Map<string, PricedCatalogRow>(
          priced.ok ? priced.value.map((p) => [p.id, p]) : [],
        );
        const flag = list[0]?.featureFlag ?? family;
        families.push({
          family,
          flag,
          enabled: flags.find((f) => f.key === flag)?.enabled === true,
          lastSyncedAt: list.reduce<Date | null>(
            (latest, r) => (latest === null || r.syncedAt > latest ? r.syncedAt : latest),
            null,
          ),
          rows: list.map((row) => ({ row, price: byId.get(row.id) ?? null })),
        });
      }
      return {
        markets,
        market,
        flags,
        families,
        images,
        imagesInvalid: stored.state === "invalid",
      };
    });
    return { kind: "ok", value };
  } catch {
    return { kind: "unavailable" };
  }
}

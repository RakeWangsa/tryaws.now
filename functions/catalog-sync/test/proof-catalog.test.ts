// Proof of WP1-T5 (the instance half): the catalog-sync function with a FAKE AWS client (fixtures of the SHAPE
// of a GetBundles answer, through the real read-only adapter) and the REAL local PostgreSQL, as worker_rw for
// the sync and web_rw for the read. Nothing here calls AWS, and nothing claims what the real answer looks
// like: that is manual VERIFY in tc-pool-dev. The TLD half is NOT proven here (the Route 53 Domains client is
// not installed), only that it is skipped with a log and never fails the instance plans.
import {
  AwsError,
  type AwsAccess,
  type AccountRef,
  type LightsailRegion,
  type RoleName,
} from "@tc/aws";
import { pricingInForce, priceCatalog, quote, type LogEvent } from "@tc/core";
import {
  LAUNCH_FX_RATE,
  applyCatalogScope,
  applyTlds,
  listActiveImages,
  readCatalogProduct,
  readFeatureFlag,
  seedLaunchData,
  type Tx,
} from "@tc/db";
import {
  attachErrorListeners,
  insertRow,
  newCustomer,
  newOrder,
  newResource,
  runTransaction,
  useTempDatabase,
  type DatabaseRole,
} from "@tc/db/testing";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CatalogSyncConfig } from "../config";
import { buildCatalogSyncDeps } from "../deps";
import {
  ACTIVE_COUNT,
  FLOAT_ARTIFACT,
  FULL_ANSWER,
  NANO,
  NANO_IPV6,
  NEGATIVE,
  SMALL_2GB,
  STORED_COUNT,
  WINDOWS_NANO,
  item,
  type BundleItem,
} from "./fixtures/bundles";

const t = useTempDatabase();

const POOL_ACCOUNT_ID = "111122223333";
const EXTERNAL_ID = "ext-secret-1";
const ROLE_NAME = "TcReader";
const FIXED = "catalog-sync: sync failed";
const SEEDED_AT = new Date("2026-11-11T00:00:00Z");
const READ_AT = { now: () => new Date("2028-06-01T00:00:00Z") };
const SG: LightsailRegion = "ap-southeast-1";
const IN: LightsailRegion = "ap-south-1";

const asRole =
  (role: DatabaseRole) =>
  <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runTransaction(t.db, fn, { role });
const asOwner = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => runTransaction(t.db, fn);

beforeAll(async () => {
  attachErrorListeners(t.pool);
  await asOwner((tx) => seedLaunchData(tx, { environment: "staging", at: SEEDED_AT }));
  await insertRow(t.pool, "pool_accounts", {
    aws_account_id: POOL_ACCOUNT_ID,
    name: "tc-pool-dev",
    tier: "dev",
    role_arn: `arn:aws:iam::${POOL_ACCOUNT_ID}:role/TcProvisioner`,
    external_id: EXTERNAL_ID,
    status: "active",
  });
});

beforeEach(async () => {
  await t.pool.query("truncate catalog_products, tlds cascade");
});

type Answer = BundleItem[] | BundleItem[][] | Error;

interface Request {
  region: string;
  role: string;
  account: AccountRef;
}

/**
 * A fake AwsAccess: `lightsail()` hands out a client whose `send` answers GetBundles from the fixtures,
 * page by page. The real adapter (`createCatalogSource`) runs on top of it.
 */
function fakeAccess(
  answers: Partial<Record<LightsailRegion, Answer>>,
  blueprints: Partial<Record<LightsailRegion, unknown[]>> = {},
) {
  const requests: Request[] = [];
  const access = {
    caller: "catalog-sync",
    lightsail(account: AccountRef, region: LightsailRegion, role: RoleName) {
      requests.push({ region, role, account });
      return {
        send: async (command: { input: { pageToken?: string } }) => {
          if (command.constructor.name === "GetBlueprintsCommand") {
            return { blueprints: blueprints[region] ?? [] };
          }
          const answer = answers[region] ?? [];
          if (answer instanceof Error) throw answer;
          const pages = (Array.isArray(answer[0]) ? answer : [answer]) as BundleItem[][];
          const index =
            command.input.pageToken === undefined ? 0 : parseInt(command.input.pageToken, 10);
          return {
            bundles: pages[index] ?? [],
            ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}),
          };
        },
      };
    },
  } as unknown as AwsAccess<"catalog-sync">;
  return { access, requests };
}

function makeSync(
  answers: Partial<Record<LightsailRegion, Answer>>,
  over: {
    config?: Partial<CatalogSyncConfig>;
    at?: string;
    role?: DatabaseRole;
    blueprints?: Partial<Record<LightsailRegion, unknown[]>>;
  } = {},
) {
  const { access, requests } = fakeAccess(answers, over.blueprints);
  const logs: LogEvent[] = [];
  const config: CatalogSyncConfig = {
    poolAccountId: POOL_ACCOUNT_ID,
    dnsAccountId: null,
    dnsExternalId: null,
    regions: [SG],
    syncTlds: false,
    ...over.config,
  };
  const at = new Date(over.at ?? "2030-01-01T00:00:00Z");
  const { handler } = buildCatalogSyncDeps({
    config,
    access,
    runTx: asRole(over.role ?? "worker_rw"),
    // The images are proven in their own test below; the other tests count catalog rows.
    syncImages: over.blueprints !== undefined,
    syncExtras: false,
    clock: { now: () => new Date(at) },
    log: (e) => logs.push(e),
  });
  return { run: (event?: unknown) => handler(event), requests, logs };
}

const state = async () =>
  (
    await t.pool.query(
      `select id, family, aws_id, region, platform, aws_price_usd::text as price, active,
              specs::text as specs, created_at, synced_at, feature_flag
         from catalog_products order by region, family, aws_id`,
    )
  ).rows;
const withoutSyncedAt = (rows: Record<string, unknown>[]) =>
  rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => k !== "synced_at")));
const scalar = async (sql: string, params: unknown[] = []) =>
  Number((await t.pool.query(sql, params)).rows[0].c);

async function priceActiveRows(clock = READ_AT) {
  const ids = (await t.pool.query("select id from catalog_products where active order by aws_id"))
    .rows;
  const result = await asRole("web_rw")(async (tx) => {
    const rows = [];
    for (const { id } of ids) {
      const row = await readCatalogProduct(tx, id as string);
      if (row !== null) rows.push(row);
    }
    return priceCatalog(tx, rows, { market: "BD" }, clock);
  });
  if (!result.ok) throw new Error("priceCatalog failed: " + result.error);
  return result.value;
}

async function ruleInForce(clock = READ_AT) {
  const found = await asRole("web_rw")((tx) =>
    pricingInForce(tx, { market: "BD", productFamily: "linux_instance" }, clock),
  );
  if (!found.ok) throw new Error("no rule in force");
  return found.value;
}

/** The catalog stores no BDT: no such column, and nothing of the kind inside `specs` (open point 8). */
async function expectNoBdtStored(): Promise<void> {
  const columns = (
    await t.pool.query(
      "select column_name from information_schema.columns where table_name = 'catalog_products'",
    )
  ).rows.map((r) => r.column_name as string);
  expect(columns.filter((c) => /bdt|minor|total/i.test(c))).toEqual([]);
  const specs = (await t.pool.query("select specs::text as s from catalog_products")).rows;
  expect(JSON.stringify(specs)).not.toMatch(/totalMinor|bdt|minor/i);
}

const rejection = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
};

describe("catalog-sync proof (fake AWS, real database)", () => {
  it("1. the catalog holds the plans with BDT prices that the engine quotes", async () => {
    const { run } = makeSync({ [SG]: FULL_ANSWER });
    const report = await run();
    expect(report.regions[0]).toMatchObject({
      ok: true,
      seen: 7,
      refused: 2,
      mapped: STORED_COUNT,
    });
    expect(await scalar("select count(*) c from catalog_products")).toBe(STORED_COUNT);

    const priced = await priceActiveRows();
    expect(priced).toHaveLength(ACTIVE_COUNT);
    for (const p of priced) {
      expect(typeof p.priceBdt.totalMinor).toBe("bigint");
      expect(p.priceBdt.totalMinor > 0n).toBe(true);
    }
    const inForce = await ruleInForce();
    await expectNoBdtStored();
    const nano = priced.find((p) => p.awsPriceUsd === "5.0000" && p.family === "linux_instance")!;
    expect(nano.priceBdt.totalMinor).toBe(
      quote({ awsPriceUsd: "5", fxRate: LAUNCH_FX_RATE, rule: inForce.rule.value }).totalMinor,
    );
  });

  it("2. no active instance plan is IPv6-only; the IPv6-only plan is stored inactive with its price", async () => {
    await makeSync({ [SG]: FULL_ANSWER }).run();
    expect(
      await scalar(
        `select count(*) c from catalog_products
          where family in ('linux_instance','windows_instance') and active
            and (specs->>'ipv6Only')::boolean`,
      ),
    ).toBe(0);
    const ipv6 = (
      await t.pool.query(
        "select active, aws_price_usd::text as price, specs->>'publicIpv4' as ips from catalog_products where aws_id = $1",
        [NANO_IPV6.bundleId],
      )
    ).rows;
    expect(ipv6).toEqual([{ active: false, price: "3.5000", ips: "0" }]);
    expect(
      await scalar(
        "select count(*) c from catalog_products where active and (specs->>'publicIpv4')::int < 1",
      ),
    ).toBe(0);
  });

  it("3. a float artifact and a negative price are absent from the table and counted refused", async () => {
    const report = await makeSync({ [SG]: [NANO, FLOAT_ARTIFACT, NEGATIVE] }).run();
    expect(report.regions[0]).toMatchObject({ refused: 2, mapped: 1 });
    expect(
      await scalar("select count(*) c from catalog_products where aws_id = any($1)", [
        [FLOAT_ARTIFACT.bundleId, NEGATIVE.bundleId],
      ]),
    ).toBe(0);
  });

  it("4. idempotent: two runs keep row count, ids and created_at; synced_at moves", async () => {
    await makeSync({ [SG]: FULL_ANSWER }, { at: "2030-01-01T00:00:00Z" }).run();
    const first = await state();
    const report = await makeSync({ [SG]: FULL_ANSWER }, { at: "2030-01-02T00:00:00Z" }).run();
    const second = await state();
    expect(report.regions[0]).toMatchObject({ inserted: 0, updated: STORED_COUNT, deactivated: 0 });
    expect(second).toHaveLength(first.length);
    expect(withoutSyncedAt(second)).toEqual(withoutSyncedAt(first));
    for (let i = 0; i < first.length; i += 1) {
      expect(second[i]!.synced_at.getTime()).toBeGreaterThan(first[i]!.synced_at.getTime());
    }
  });

  it("5. a bundle that disappears is deactivated, the row stays and a resource still joins it", async () => {
    await makeSync({ [SG]: [NANO, SMALL_2GB] }).run();
    const small = (
      await t.pool.query("select id from catalog_products where aws_id = $1", [SMALL_2GB.bundleId])
    ).rows[0].id as string;
    const customerId = await newCustomer(t.pool);
    await newResource(t.pool, customerId, { product_id: small });

    const report = await makeSync({ [SG]: [NANO] }).run();
    expect(report.regions[0]).toMatchObject({ deactivated: 1 });
    const joined = (
      await t.pool.query(
        `select p.aws_id, p.active from resources r join catalog_products p on p.id = r.product_id
          where r.customer_id = $1`,
        [customerId],
      )
    ).rows;
    expect(joined).toEqual([{ aws_id: SMALL_2GB.bundleId, active: false }]);
    expect(await scalar("select count(*) c from catalog_products")).toBe(2);
  });

  it("6. a price change updates the row, leaves an order untouched, and the BDT follows on read only", async () => {
    await makeSync({ [SG]: [NANO] }).run();
    const customerId = await newCustomer(t.pool);
    const orderId = await newOrder(t.pool, customerId);
    const orderBefore = (await t.pool.query("select * from orders where id = $1", [orderId])).rows;
    const before = (await priceActiveRows())[0]!;

    await makeSync(
      { [SG]: [item(NANO.bundleId, { price: 6 })] },
      { at: "2030-01-02T00:00:00Z" },
    ).run();
    expect(
      (await t.pool.query("select aws_price_usd::text as p from catalog_products")).rows[0].p,
    ).toBe("6.0000");
    expect((await t.pool.query("select * from orders where id = $1", [orderId])).rows).toEqual(
      orderBefore,
    );
    const after = (await priceActiveRows())[0]!;
    const inForce = await ruleInForce();
    expect(after.priceBdt.totalMinor).toBe(
      quote({ awsPriceUsd: "6", fxRate: LAUNCH_FX_RATE, rule: inForce.rule.value }).totalMinor,
    );
    expect(after.priceBdt.totalMinor > before.priceBdt.totalMinor).toBe(true);

    // A new FX row changes the value on read and no stored value: the catalog stores no BDT.
    const stored = await state();
    await insertRow(t.pool, "fx_rates", {
      market: "BD",
      rate: "130",
      effective_from: "2029-01-01T00:00:00Z",
    });
    const reRead = (await priceActiveRows({ now: () => new Date("2030-06-01T00:00:00Z") }))[0]!;
    expect(reRead.priceBdt.totalMinor > after.priceBdt.totalMinor).toBe(true);
    expect(await state()).toEqual(stored);
    await expectNoBdtStored();
  });

  it("7. fail closed: a failing Region keeps its rows, the other is updated, the next healthy run repairs it", async () => {
    const both = { [SG]: [NANO, SMALL_2GB], [IN]: [NANO, SMALL_2GB] };
    const config = { regions: [IN, SG] };
    await makeSync(both, { config }).run();
    const inBefore = (await state()).filter((r) => r.region === IN);

    const broken = makeSync(
      {
        [IN]: new Error(`AccessDenied acct ${POOL_ACCOUNT_ID} ${EXTERNAL_ID}`),
        [SG]: [item(NANO.bundleId, { price: 6 }), SMALL_2GB],
      },
      { config, at: "2030-01-02T00:00:00Z" },
    );
    expect(await rejection(broken.run())).toBe(FIXED);
    const afterBreak = await state();
    expect(afterBreak.filter((r) => r.region === IN)).toEqual(inBefore);
    expect(afterBreak.find((r) => r.region === SG && r.aws_id === NANO.bundleId)!.price).toBe(
      "6.0000",
    );

    await makeSync(
      {
        [IN]: [item(NANO.bundleId, { price: 6 }), SMALL_2GB],
        [SG]: [item(NANO.bundleId, { price: 6 }), SMALL_2GB],
      },
      { config, at: "2030-01-03T00:00:00Z" },
    ).run();
    const repaired = await state();
    expect(repaired.find((r) => r.region === IN && r.aws_id === NANO.bundleId)!.price).toBe(
      "6.0000",
    );
  });

  it("8. an empty answer for a Region with active rows changes nothing and fails the scope", async () => {
    await makeSync({ [SG]: FULL_ANSWER }).run();
    const before = await state();
    const empty = makeSync({ [SG]: [] }, { at: "2030-01-02T00:00:00Z" });
    expect(await rejection(empty.run())).toBe(FIXED);
    expect(await state()).toEqual(before);
    expect(
      empty.logs.find((l) => l.event === "catalog_sync_scope" && l.region === SG),
    ).toMatchObject({ ok: false, reason: "unsafe_plan" });
  });

  it("9. two handlers at once give no unique violation and one consistent final state (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      await t.pool.query("truncate catalog_products cascade");
      const results = await Promise.allSettled([
        makeSync({ [SG]: FULL_ANSWER }).run(),
        makeSync({ [SG]: FULL_ANSWER }, { at: "2030-01-02T00:00:00Z" }).run(),
      ]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await scalar("select count(*) c from catalog_products")).toBe(STORED_COUNT);
      expect(await scalar("select count(*) c from catalog_products where active")).toBe(
        ACTIVE_COUNT,
      );
      expect(
        await scalar(
          `select count(*) c from (select family, aws_id, region from catalog_products
            group by 1, 2, 3 having count(*) > 1) d`,
        ),
      ).toBe(0);
    }
  });

  it("10. the sync runs as worker_rw; web_rw cannot write the catalog or the TLDs", async () => {
    await makeSync({ [SG]: [NANO] }, { role: "worker_rw" }).run();
    const row = {
      family: "linux_instance",
      awsId: "evil_1_0",
      platform: "linux",
      region: SG,
      specs: {},
      awsPriceUsd: "1",
      billingUnit: "month",
      featureFlag: "linux_instance",
      active: true,
    };
    const at = new Date("2030-01-01T00:00:00Z");
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { code?: string; cause?: { code?: string } };
        return err.code ?? err.cause?.code;
      }
      return "no error";
    };
    expect(
      await code(
        asRole("web_rw")((tx) => applyCatalogScope(tx, { rows: [row], deactivate: [], at })),
      ),
    ).toBe("42501");
    expect(
      await code(
        asRole("web_rw")((tx) =>
          applyTlds(tx, {
            rows: [
              {
                tld: "com",
                registrationUsd: "12",
                renewalUsd: null,
                transferUsd: null,
                needsExtraParams: false,
              },
            ],
            at,
          }),
        ),
      ),
    ).toBe("42501");
    expect(await scalar("select count(*) c from catalog_products where aws_id = 'evil_1_0'")).toBe(
      0,
    );
  });

  it("11. the TLD half is skipped with a log and never fails the instance plans (TLD prices NOT proven)", async () => {
    const { run, logs } = makeSync(
      { [SG]: FULL_ANSWER },
      { config: { dnsAccountId: "444455556666", dnsExternalId: "dns-ext-1", syncTlds: true } },
    );
    const report = await run();
    expect(report.regions[0]).toMatchObject({ ok: true });
    expect(report.tlds).toEqual({ ok: false, skipped: true, inserted: 0, updated: 0 });
    expect(logs.find((l) => l.event === "catalog_sync_tlds")).toMatchObject({
      ok: false,
      skipped: true,
      reason: "not_configured",
    });
    expect(await scalar("select count(*) c from catalog_products")).toBe(STORED_COUNT);
    expect(await scalar("select count(*) c from tlds")).toBe(0);
  });

  it("12. the sync writes no feature flag; the Windows row waits behind a flag that is off (R12)", async () => {
    const flagsBefore = await scalar("select count(*) c from feature_flags");
    await makeSync({ [SG]: FULL_ANSWER }).run();
    expect(await scalar("select count(*) c from feature_flags")).toBe(flagsBefore);
    const windows = (
      await t.pool.query(
        "select feature_flag, platform, active from catalog_products where aws_id = $1",
        [WINDOWS_NANO.bundleId],
      )
    ).rows;
    expect(windows).toEqual([
      { feature_flag: "windows_instance", platform: "windows", active: true },
    ]);
    expect(await asRole("web_rw")((tx) => readFeatureFlag(tx, "windows_instance", "BD"))).toBe(
      false,
    );
  });

  it("13. logs are fixed JSON events; no account id, ExternalId or role name appears in a line or an error", async () => {
    const run = makeSync(
      {
        [IN]: new Error(`AccessDenied ${POOL_ACCOUNT_ID} ${EXTERNAL_ID} ${ROLE_NAME}`),
        [SG]: FULL_ANSWER,
      },
      { config: { regions: [IN, SG] } },
    );
    const message = await rejection(run.run());
    const aws = makeSync(
      {
        [IN]: new AwsError({ code: "forbidden", retryable: false, reason: "role_not_allowed" }),
        [SG]: FULL_ANSWER,
      },
      { config: { regions: [IN, SG] } },
    );
    const message2 = await rejection(aws.run());
    for (const logs of [run.logs, aws.logs]) {
      expect(logs.length).toBeGreaterThan(0);
      for (const line of logs) {
        expect(["catalog_sync", "catalog_sync_scope", "catalog_sync_tlds"]).toContain(line.event);
        const text = JSON.stringify(line);
        for (const secret of [POOL_ACCOUNT_ID, EXTERNAL_ID, ROLE_NAME]) {
          expect(text).not.toContain(secret);
        }
        expect(() => JSON.parse(text)).not.toThrow();
      }
    }
    for (const m of [message, message2]) {
      expect(m).toBe(FIXED);
    }
  });

  it("14. Regions run in the configured order, and the event never chooses a scope or an account", async () => {
    const hostile = { region: "evil", Records: [{ body: "x" }], awsAccountId: "999999999999" };
    for (const event of [hostile, null, undefined]) {
      const { run, requests } = makeSync(
        { [IN]: [NANO], [SG]: [NANO] },
        { config: { regions: [IN, SG] } },
      );
      await run(event);
      expect(requests.map((r) => r.region)).toEqual([IN, SG]);
      expect(requests.every((r) => r.role === ROLE_NAME)).toBe(true);
      expect(requests.every((r) => r.account.awsAccountId === POOL_ACCOUNT_ID)).toBe(true);
      expect(requests.every((r) => r.account.externalId === EXTERNAL_ID)).toBe(true);
    }
  });

  it("pages are followed: an answer in two pages is stored whole", async () => {
    await makeSync({ [SG]: [[NANO, NANO_IPV6], [SMALL_2GB]] }).run();
    expect(await scalar("select count(*) c from catalog_products")).toBe(3);
  });

  it("WPU-G3: the Linux images are stored as the family blueprint with no price, never as a plan, and read by web_rw", async () => {
    const bp = (blueprintId: string, over: Record<string, unknown> = {}) => ({
      blueprintId,
      name: blueprintId,
      type: "os",
      group: "g",
      version: "1",
      platform: "LINUX_UNIX",
      isActive: true,
      ...over,
    });
    const blueprints = {
      [SG]: [
        bp("ubuntu_24_04"),
        bp("wordpress", { type: "app" }),
        bp("windows_server_2022", { platform: "WINDOWS" }),
      ],
    };
    const first = await makeSync({ [SG]: [NANO] }, { blueprints }).run();
    expect(first.images).toEqual([
      { region: SG, ok: true, seen: 3, mapped: 2, inserted: 2, updated: 0, deactivated: 0 },
    ]);
    const images = (
      await t.pool.query(
        "select aws_id, platform, active, aws_price_usd::text as price, billing_unit, feature_flag, specs from catalog_products where family = 'blueprint' order by aws_id",
      )
    ).rows;
    expect(images.map((r) => r.aws_id)).toEqual(["ubuntu_24_04", "wordpress"]);
    expect(images[0]).toMatchObject({
      platform: "linux",
      active: true,
      price: "0.0000",
      billing_unit: "none",
      feature_flag: "linux_instance",
      specs: { name: "ubuntu_24_04", kind: "os", loginUser: "ubuntu" },
    });
    expect(images[1].specs).toMatchObject({ kind: "app", loginUser: "bitnami" });
    // The plans of the Region are untouched by the image rows, and a second run changes nothing.
    expect(
      await scalar("select count(*) c from catalog_products where family <> 'blueprint'"),
    ).toBe(1);
    const second = await makeSync({ [SG]: [NANO] }, { blueprints }).run();
    expect(second.images[0]).toMatchObject({ inserted: 0, updated: 2, deactivated: 0 });
    const read = await asRole("web_rw")((tx) => listActiveImages(tx, SG));
    expect(read.map((r) => r.awsId)).toEqual(["ubuntu_24_04", "wordpress"]);
    // An image AWS stops listing is deactivated and no longer offered.
    await makeSync({ [SG]: [NANO] }, { blueprints: { [SG]: [bp("ubuntu_24_04")] } }).run();
    const after = await asRole("web_rw")((tx) => listActiveImages(tx, SG));
    expect(after.map((r) => r.awsId)).toEqual(["ubuntu_24_04"]);
  });
});

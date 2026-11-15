import { AwsError, type AccountRef, type CatalogSource, type LightsailRegion } from "@tc/aws";
import type {
  LogEvent,
  RawBlueprint,
  RawBundle,
  RawContainerPower,
  RawDbBlueprint,
  RawDistributionBundle,
} from "@tc/core";
import { describe, expect, it } from "vitest";
import { createCatalogSyncHandler, type CatalogStore, type CatalogSyncDeps } from "./handler";

const ACCOUNT_ID = "111122223333";
const EXTERNAL_ID = "ext-secret-1";
const POOL: AccountRef = { awsAccountId: ACCOUNT_ID, externalId: EXTERNAL_ID };
const A: LightsailRegion = "ap-south-1";
const B: LightsailRegion = "ap-southeast-1";
const FIXED = "catalog-sync: sync failed";

function bundle(id: string, over: Partial<RawBundle> = {}): RawBundle {
  return {
    bundleId: id,
    name: id,
    cpuCount: 2,
    ramSizeInGb: 1,
    diskSizeInGb: 40,
    transferPerMonthInGb: 2048,
    priceUsd: "5",
    publicIpv4AddressCount: 1,
    supportedPlatforms: ["LINUX_UNIX"],
    isActive: true,
    instanceType: "nano",
    power: 500,
    ...over,
  };
}

interface Row {
  active: boolean;
  priceUsd: string;
}

/** An in-memory store with no delete method: the type of CatalogStore forbids one. */
function fakeStore(over: { account?: AccountRef | null } = {}) {
  const rows = new Map<string, Row>();
  const key = (r: string, f: string, id: string) => `${r}|${f}|${id}`;
  const store: CatalogStore = {
    async poolAccount() {
      return over.account === undefined ? POOL : over.account;
    },
    async existing(scope) {
      return [...rows.entries()]
        .map(([k, v]) => ({ k: k.split("|"), v }))
        .filter(({ k }) => k[0] === scope.region && scope.families.includes(k[1]!))
        .map(({ k, v }) => ({ family: k[1]!, awsId: k[2]!, active: v.active }));
    },
    async apply(scope) {
      let inserted = 0;
      let updated = 0;
      for (const r of scope.rows) {
        const k = key(r.region, r.family, r.awsId);
        if (rows.has(k)) updated += 1;
        else inserted += 1;
        rows.set(k, { active: r.active, priceUsd: r.awsPriceUsd });
      }
      let deactivated = 0;
      for (const d of scope.deactivate) {
        const k = key(d.region, d.family, d.awsId);
        const row = rows.get(k);
        if (row?.active) {
          row.active = false;
          deactivated += 1;
        }
      }
      return { inserted, updated, deactivated };
    },
    async applyImages(scope) {
      let inserted = 0;
      let updated = 0;
      for (const r of scope.rows) {
        const k = key(r.region, r.family, r.awsId);
        if (rows.has(k)) updated += 1;
        else inserted += 1;
        rows.set(k, { active: r.active, priceUsd: r.awsPriceUsd });
      }
      let deactivated = 0;
      for (const d of scope.deactivate) {
        const row = rows.get(key(d.region, d.family, d.awsId));
        if (row?.active) {
          row.active = false;
          deactivated += 1;
        }
      }
      return { inserted, updated, deactivated };
    },
    async applyExtra(scope) {
      let inserted = 0;
      let updated = 0;
      for (const r of scope.rows) {
        const k = key(r.region, r.family, r.awsId);
        if (rows.has(k)) updated += 1;
        else inserted += 1;
        rows.set(k, { active: r.active, priceUsd: r.awsPriceUsd });
      }
      let deactivated = 0;
      for (const d of scope.deactivate) {
        const row = rows.get(key(d.region, d.family, d.awsId));
        if (row?.active) {
          row.active = false;
          deactivated += 1;
        }
      }
      return { inserted, updated, deactivated };
    },
    async applyTlds(list) {
      return { inserted: list.length, updated: 0 };
    },
  };
  return { store, rows };
}

function harness(
  answers: Partial<Record<LightsailRegion, RawBundle[] | Error>>,
  over: Partial<CatalogSyncDeps> = {},
) {
  const images: Partial<Record<LightsailRegion, RawBlueprint[] | Error>> = {};
  const calls: { region: string; account: AccountRef }[] = [];
  const extras: {
    cdn: RawDistributionBundle[] | Error;
    db: Partial<Record<LightsailRegion, RawDbBlueprint[] | Error>>;
    containers: Partial<Record<LightsailRegion, RawContainerPower[] | Error>>;
  } = { cdn: [], db: {}, containers: {} };
  let tldCalls = 0;
  const logs: LogEvent[] = [];
  const { store, rows } = fakeStore();
  const source: CatalogSource = {
    async instanceBundles(account, region) {
      calls.push({ region, account });
      const answer = answers[region];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async instanceBlueprints(_account, region) {
      const answer = images[region];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async distributionBundles() {
      if (extras.cdn instanceof Error) throw extras.cdn;
      return extras.cdn;
    },
    async containerPowers(_account, region) {
      const answer = extras.containers[region];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async databaseBlueprints(_account, region) {
      const answer = extras.db[region];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    },
    async tldPrices() {
      tldCalls += 1;
      return [
        {
          tld: "com",
          registrationUsd: "12",
          renewalUsd: "12",
          transferUsd: "12",
          needsExtraParams: false,
        },
      ];
    },
  };
  const deps: CatalogSyncDeps = {
    source,
    store,
    clock: { now: () => new Date("2030-01-01T00:00:00Z") },
    log: (e) => logs.push(e),
    poolAccountId: ACCOUNT_ID,
    dnsAccount: null,
    regions: [A, B],
    syncTlds: false,
    syncImages: false,
    ...over,
  };
  return {
    run: (event?: unknown) => createCatalogSyncHandler(deps)(event),
    calls,
    logs,
    rows,
    tldCalls: () => tldCalls,
    images,
    extras,
    deps,
  };
}

const ONE = [bundle("nano_3_0"), bundle("micro_3_0", { priceUsd: "7" })];

describe("catalog-sync handler", () => {
  it("writes the mapped rows and reports the counts", async () => {
    const h = harness({
      [A]: [
        bundle("nano_3_0"),
        bundle("nano_ipv6_3_0", { publicIpv4AddressCount: 0, priceUsd: "3.5" }),
        bundle("bad", { priceUsd: "" }),
      ],
      [B]: ONE,
    });
    const report = await h.run();
    expect(report.regions).toEqual([
      {
        region: A,
        ok: true,
        seen: 3,
        mapped: 2,
        refused: 1,
        active: 1,
        inactiveIpv6: 1,
        inserted: 2,
        updated: 0,
        deactivated: 0,
      },
      {
        region: B,
        ok: true,
        seen: 2,
        mapped: 2,
        refused: 0,
        active: 2,
        inactiveIpv6: 0,
        inserted: 2,
        updated: 0,
        deactivated: 0,
      },
    ]);
    expect(h.rows.get(`${A}|linux_instance|nano_ipv6_3_0`)).toEqual({
      active: false,
      priceUsd: "3.5",
    });
    expect(h.tldCalls()).toBe(0);
    expect(report.tlds).toBeNull();
  });

  it("a failing Region leaves its rows alone, B is written, the run fails with the fixed message", async () => {
    const h = harness({
      [A]: new Error(`AccessDenied acct ${ACCOUNT_ID} ${EXTERNAL_ID}`),
      [B]: ONE,
    });
    h.rows.set(`${A}|linux_instance|old_1_0`, { active: true, priceUsd: "9" });
    const before = JSON.stringify([...h.rows]);
    let thrown: unknown;
    try {
      await h.run();
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe(FIXED);
    expect(h.rows.get(`${B}|linux_instance|nano_3_0`)?.active).toBe(true);
    expect(JSON.stringify([...h.rows].filter(([k]) => k.startsWith(A)))).toBe(
      JSON.stringify(JSON.parse(before)),
    );
    const scopeA = h.logs.find((l) => l.event === "catalog_sync_scope" && l.region === A);
    expect(scopeA).toMatchObject({ ok: false, reason: "failed" });
    const everything = JSON.stringify(h.logs) + String((thrown as Error).message);
    expect(everything).not.toContain(ACCOUNT_ID);
    expect(everything).not.toContain(EXTERNAL_ID);
  });

  it("an AwsError is logged with its fixed code, not its text", async () => {
    const h = harness({
      [A]: new AwsError({ code: "forbidden", retryable: false, reason: "role_not_allowed" }),
      [B]: ONE,
    });
    await expect(h.run()).rejects.toThrow(FIXED);
    const scopeA = h.logs.find((l) => l.event === "catalog_sync_scope" && l.region === A);
    expect(scopeA).toMatchObject({ ok: false, reason: "aws_error", errorCode: "forbidden" });
  });

  it("an empty answer for a Region with active rows is an unsafe plan: nothing is deactivated", async () => {
    const h = harness({ [A]: [], [B]: ONE });
    h.rows.set(`${A}|linux_instance|old_1_0`, { active: true, priceUsd: "9" });
    await expect(h.run()).rejects.toThrow(FIXED);
    expect(h.rows.get(`${A}|linux_instance|old_1_0`)?.active).toBe(true);
    expect(h.logs.find((l) => l.event === "catalog_sync_scope" && l.region === A)).toMatchObject({
      ok: false,
      reason: "unsafe_plan",
    });
  });

  it("a bundle that disappears is deactivated, never deleted", async () => {
    const first = harness({ [A]: ONE, [B]: ONE });
    await first.run();
    const answers: Partial<Record<LightsailRegion, RawBundle[]>> = {
      [A]: [bundle("nano_3_0")],
      [B]: ONE,
    };
    // Same store, a second answer.
    const second = harness(answers);
    for (const [k, v] of first.rows) second.rows.set(k, { ...v });
    const report = await second.run();
    expect(report.regions[0]).toMatchObject({ deactivated: 1 });
    expect(second.rows.get(`${A}|linux_instance|micro_3_0`)).toEqual({
      active: false,
      priceUsd: "7",
    });
    expect(second.rows.size).toBe(first.rows.size);
  });

  it("two runs in a row give equal store contents (R7)", async () => {
    const h = harness({ [A]: ONE, [B]: ONE });
    await h.run();
    const once = JSON.stringify([...h.rows]);
    const report = await h.run();
    expect(JSON.stringify([...h.rows])).toBe(once);
    expect(report.regions.every((r) => r.inserted === 0 && r.deactivated === 0)).toBe(true);
  });

  it("an unknown pool account fails before any AWS call", async () => {
    const h = harness({ [A]: ONE, [B]: ONE });
    h.deps.store.poolAccount = async () => null;
    await expect(h.run()).rejects.toThrow(FIXED);
    expect(h.calls).toHaveLength(0);
    expect(h.logs.some((l) => l.event === "catalog_sync" && l.result === "failed")).toBe(true);
    expect(JSON.stringify(h.logs)).not.toContain(ACCOUNT_ID);
  });

  it("passes the account to the source and the configured Regions in order", async () => {
    const h = harness({ [A]: ONE, [B]: ONE });
    await h.run();
    expect(h.calls.map((c) => c.region)).toEqual([A, B]);
    expect(h.calls[0]!.account).toEqual(POOL);
  });

  it("ignores the event: hostile, null and undefined give the same result", async () => {
    const results: string[] = [];
    for (const event of [{ region: "evil", Records: [{ body: "x" }] }, null, undefined]) {
      const h = harness({ [A]: ONE, [B]: ONE });
      results.push(JSON.stringify(await h.run(event)));
      expect(h.calls.map((c) => c.region)).toEqual([A, B]);
    }
    expect(new Set(results).size).toBe(1);
  });

  describe("TLDs", () => {
    const dns: AccountRef = { awsAccountId: "444455556666", externalId: "dns-ext-1" };

    it("syncTlds false never calls tldPrices; true writes them", async () => {
      const off = harness({ [A]: ONE, [B]: ONE });
      await off.run();
      expect(off.tldCalls()).toBe(0);
      const on = harness({ [A]: ONE, [B]: ONE }, { syncTlds: true, dnsAccount: dns });
      const report = await on.run();
      expect(on.tldCalls()).toBe(1);
      expect(report.tlds).toMatchObject({ ok: true, inserted: 1 });
    });

    it("a TLD failure does not roll back the Regions", async () => {
      const h = harness({ [A]: ONE, [B]: ONE }, { syncTlds: true, dnsAccount: dns });
      h.deps.source.tldPrices = async () => {
        throw new Error(`boom ${dns.awsAccountId} ${dns.externalId}`);
      };
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.size).toBe(4);
      const text = JSON.stringify(h.logs);
      expect(text).not.toContain(dns.awsAccountId);
      expect(text).not.toContain(dns.externalId);
    });

    it("an unconfigured TLD source is skipped with a log; the instance sync passes", async () => {
      const h = harness({ [A]: ONE, [B]: ONE }, { syncTlds: true, dnsAccount: dns });
      h.deps.source.tldPrices = async () => {
        throw new AwsError({ code: "internal", retryable: false, reason: "not_configured" });
      };
      const report = await h.run();
      expect(report.tlds).toEqual({ ok: false, skipped: true, inserted: 0, updated: 0 });
      expect(h.logs.find((l) => l.event === "catalog_sync_tlds")).toMatchObject({
        ok: false,
        skipped: true,
        reason: "not_configured",
      });
      expect(h.rows.size).toBe(4);
    });

    it("syncTlds without a DNS account is a failed TLD step, not a call", async () => {
      const h = harness({ [A]: ONE, [B]: ONE }, { syncTlds: true, dnsAccount: null });
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.tldCalls()).toBe(0);
    });
  });

  it("the budget stops new scopes", async () => {
    let t = 0;
    const h = harness(
      { [A]: ONE, [B]: ONE },
      { clock: { now: () => new Date(Date.UTC(2030, 0, 1) + t) }, budgetMs: 240_000 },
    );
    const inner = h.deps.source.instanceBundles;
    h.deps.source.instanceBundles = async (account, region) => {
      t += 300_000;
      return inner(account, region);
    };
    await expect(h.run()).rejects.toThrow(FIXED);
    expect(h.calls.map((c) => c.region)).toEqual([A]);
    expect(h.logs.find((l) => l.event === "catalog_sync_scope" && l.region === B)).toMatchObject({
      ok: false,
      reason: "budget",
    });
  });

  describe("images (WPU-G3)", () => {
    const bp = (id: string, over: Partial<RawBlueprint> = {}): RawBlueprint => ({
      blueprintId: id,
      name: id,
      type: "os",
      group: null,
      version: null,
      platform: "LINUX_UNIX",
      isActive: true,
      ...over,
    });
    const on = (answers = { [A]: ONE, [B]: ONE }) => harness(answers, { syncImages: true });

    it("syncImages false never calls GetBlueprints (the report has no image entries)", async () => {
      const h = harness({ [A]: ONE, [B]: ONE });
      h.images[A] = new Error("must not be called");
      const report = await h.run();
      expect(report.images).toEqual([]);
    });

    it("writes the Linux images of each Region as the family blueprint and skips Windows and bad ids", async () => {
      const h = on();
      for (const r of [A, B]) {
        h.images[r] = [
          bp("ubuntu_24_04"),
          bp("wordpress", { type: "app" }),
          bp("windows_server_2022", { platform: "WINDOWS" }),
          bp("Bad Id"),
        ];
      }
      const report = await h.run();
      expect(report.images).toEqual([
        { region: A, ok: true, seen: 4, mapped: 2, inserted: 2, updated: 0, deactivated: 0 },
        { region: B, ok: true, seen: 4, mapped: 2, inserted: 2, updated: 0, deactivated: 0 },
      ]);
      expect(h.rows.get(`${A}|blueprint|wordpress`)).toEqual({ active: true, priceUsd: "0" });
      expect(h.rows.has(`${A}|blueprint|windows_server_2022`)).toBe(false);
    });

    it("an image AWS no longer lists is deactivated, never deleted; a second run changes nothing (R7)", async () => {
      const h = on();
      h.images[A] = [bp("ubuntu_24_04"), bp("old_image")];
      h.images[B] = [bp("ubuntu_24_04")];
      await h.run();
      h.images[A] = [bp("ubuntu_24_04")];
      const second = await h.run();
      expect(second.images[0]).toMatchObject({ deactivated: 1, inserted: 0 });
      expect(h.rows.get(`${A}|blueprint|old_image`)?.active).toBe(false);
      const third = await h.run();
      expect(third.images[0]).toMatchObject({ deactivated: 0, inserted: 0 });
    });

    it("an answer with no usable Linux image is refused before any write and fails the run", async () => {
      const h = on();
      h.images[A] = [bp("ubuntu_24_04")];
      await h.run().catch(() => undefined);
      h.images[A] = [bp("windows_server_2022", { platform: "WINDOWS" })];
      h.images[B] = [];
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.get(`${A}|blueprint|ubuntu_24_04`)?.active).toBe(true);
    });

    it("a failing image scope is logged with a fixed reason and does not stop the other Region", async () => {
      const h = on();
      h.images[A] = new Error(`secret ${ACCOUNT_ID}`);
      h.images[B] = [bp("ubuntu_24_04")];
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.has(`${B}|blueprint|ubuntu_24_04`)).toBe(true);
      const text = JSON.stringify(h.logs);
      expect(text).not.toContain(ACCOUNT_ID);
    });
  });

  describe("CDN bundles and database engines (WPU-B5)", () => {
    const cdn = (
      bundleId: string,
      over: Partial<RawDistributionBundle> = {},
    ): RawDistributionBundle => ({
      bundleId,
      name: "Small",
      priceUsd: "5",
      transferPerMonthInGb: 50,
      isActive: true,
      ...over,
    });
    const db = (blueprintId: string, over: Partial<RawDbBlueprint> = {}): RawDbBlueprint => ({
      blueprintId,
      engine: "postgres",
      engineVersion: "16.4",
      engineDescription: "PostgreSQL",
      engineVersionDescription: "PostgreSQL 16.4-R1",
      isEngineDefault: true,
      ...over,
    });
    const on = () => harness({ [A]: ONE, [B]: ONE }, { syncCdn: true, syncDbBlueprints: true });

    it("off by default: neither source method is called and the report has no entries", async () => {
      const h = harness({ [A]: ONE, [B]: ONE });
      h.extras.cdn = new Error("must not be called");
      h.extras.db[A] = new Error("must not be called");
      const report = await h.run();
      expect(report).not.toHaveProperty("cdn");
      expect(report).not.toHaveProperty("dbBlueprints");
    });

    it("writes the CDN bundles in us-east-1 and the engines of each Region", async () => {
      const h = on();
      h.extras.cdn = [cdn("small_1_0"), cdn("bad id"), cdn("medium_1_0", { priceUsd: "" })];
      h.extras.db[A] = [
        db("postgres_16"),
        db("mysql_8_0", { engine: "mysql", engineVersion: "8.0.36" }),
      ];
      h.extras.db[B] = [db("postgres_16")];
      const report = await h.run();
      expect(report.cdn).toEqual({
        region: "us-east-1",
        ok: true,
        seen: 3,
        mapped: 1,
        inserted: 1,
        updated: 0,
        deactivated: 0,
      });
      expect(report.dbBlueprints?.map((r) => [r.region, r.mapped])).toEqual([
        [A, 2],
        [B, 1],
      ]);
      expect(h.rows.get("us-east-1|cdn|small_1_0")).toEqual({ active: true, priceUsd: "5" });
      expect(h.rows.get(`${A}|db_blueprint|mysql_8_0`)).toEqual({ active: true, priceUsd: "0" });
    });

    it("a bundle AWS no longer lists is deactivated, never deleted; a second run changes nothing (R7)", async () => {
      const h = on();
      h.extras.cdn = [cdn("small_1_0"), cdn("old_1_0")];
      h.extras.db[A] = [db("postgres_16")];
      h.extras.db[B] = [db("postgres_16")];
      await h.run();
      h.extras.cdn = [cdn("small_1_0")];
      const second = await h.run();
      expect(second.cdn).toMatchObject({ deactivated: 1, inserted: 0 });
      expect(h.rows.get("us-east-1|cdn|old_1_0")?.active).toBe(false);
      const third = await h.run();
      expect(third.cdn).toMatchObject({ deactivated: 0, inserted: 0 });
    });

    it("an answer with nothing usable is refused before any write and fails the run (R16)", async () => {
      const h = on();
      h.extras.cdn = [cdn("small_1_0")];
      h.extras.db[A] = [db("postgres_16")];
      h.extras.db[B] = [db("postgres_16")];
      await h.run();
      h.extras.cdn = [];
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.get("us-east-1|cdn|small_1_0")?.active).toBe(true);
    });

    // WPU-X20: the container powers of each Region (Gate B: no plan was for sale because nothing wrote them).
    const power = (name: string, over: Partial<RawContainerPower> = {}): RawContainerPower => ({
      powerId: `${name}-1`,
      name,
      priceUsd: "7",
      cpuCount: 0.25,
      ramSizeInGb: 0.5,
      isActive: true,
      ...over,
    });

    it("writes the container powers of each Region as scale-1 rows and skips a power it cannot trust", async () => {
      const h = harness({ [A]: ONE, [B]: ONE }, { syncContainers: true });
      h.extras.containers[A] = [power("nano"), power("micro", { priceUsd: "10" }), power("odd")];
      h.extras.containers[B] = [power("nano")];
      const report = await h.run();
      expect(report.containers?.map((r) => [r.region, r.mapped, r.ok])).toEqual([
        [A, 2, true],
        [B, 1, true],
      ]);
      expect(h.rows.get(`${A}|container_service|nano`)).toEqual({ active: true, priceUsd: "7" });
      expect(h.rows.has(`${A}|container_service|odd`)).toBe(false);
      const again = await h.run();
      expect(again.containers?.[0]).toMatchObject({ inserted: 0, deactivated: 0 });
    });

    it("off by default; an empty answer fails the run and keeps the rows (R16)", async () => {
      const off = harness({ [A]: ONE, [B]: ONE });
      off.extras.containers[A] = new Error("must not be called");
      expect(await off.run()).not.toHaveProperty("containers");
      const h = harness({ [A]: ONE, [B]: ONE }, { syncContainers: true });
      h.extras.containers[A] = [power("nano")];
      h.extras.containers[B] = [power("nano")];
      await h.run();
      h.extras.containers[A] = [];
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.get(`${A}|container_service|nano`)?.active).toBe(true);
    });

    it("a failing scope logs a fixed reason, does not stop the other Region and leaks nothing", async () => {
      const h = on();
      h.extras.cdn = [cdn("small_1_0")];
      h.extras.db[A] = new Error(`secret ${ACCOUNT_ID}`);
      h.extras.db[B] = [db("postgres_16")];
      await expect(h.run()).rejects.toThrow(FIXED);
      expect(h.rows.has(`${B}|db_blueprint|postgres_16`)).toBe(true);
      expect(JSON.stringify(h.logs)).not.toContain(ACCOUNT_ID);
    });
  });

  it("the summary line has only numbers, booleans and fixed strings", async () => {
    const h = harness({ [A]: ONE, [B]: new Error(`x ${ACCOUNT_ID}`) });
    await h.run().catch(() => undefined);
    const lines = h.logs.filter((l) => l.event === "catalog_sync");
    expect(lines).toHaveLength(1);
    for (const [k, v] of Object.entries(lines[0]!)) {
      expect(["number", "boolean", "string"]).toContain(typeof v);
      if (typeof v === "string") expect(["catalog_sync", "failed", "ok"], k).toContain(v);
    }
    for (const l of h.logs) {
      const text = JSON.stringify(l);
      expect(text).not.toContain(ACCOUNT_ID);
      expect(text).not.toContain(EXTERNAL_ID);
      expect(text).not.toContain("TcReader");
    }
  });
});

import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createCatalogSource } from "../catalog";
import { AwsError } from "../errors";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailError, lightsailOk } from "./fake-aws";

// WPU-B5 item 23. The shapes are those of the current Lightsail API reference (checked 2026-11-13):
// GetDistributionBundles answers { bundles: [{ bundleId, isActive, name, price, transferPerMonthInGb }] }
// with no page token, and GetRelationalDatabaseBlueprints answers { blueprints: [{ blueprintId, engine,
// engineDescription, engineVersion, engineVersionDescription, isEngineDefault }], nextPageToken }.
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const NOW = Date.now();
const clock = { now: () => new Date(NOW) };

function setup(opts?: { maxPages?: number }) {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({
    caller: "catalog-sync",
    clock,
    requestHandler: aws.handler,
  });
  return { aws, source: createCatalogSource(access, opts) };
}

const dist = (over: Record<string, unknown> = {}) => ({
  bundleId: "small_1_0",
  name: "Small",
  price: 5,
  transferPerMonthInGb: 50,
  isActive: true,
  ...over,
});
const dbp = (over: Record<string, unknown> = {}) => ({
  blueprintId: "postgres_16",
  engine: "postgres",
  engineDescription: "PostgreSQL",
  engineVersion: "16.4",
  engineVersionDescription: "PostgreSQL 16.4-R1",
  isEngineDefault: true,
  ...over,
});

it("distributionBundles: reads GetDistributionBundles in us-east-1 with TcReader, price as decimal text", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetDistributionBundles",
    lightsailOk({
      bundles: [dist(), dist({ bundleId: "medium_1_0", name: "Medium", price: 10.5 })],
    }),
  );
  const out = await source.distributionBundles(POOL);
  expect(out).toEqual([
    {
      bundleId: "small_1_0",
      name: "Small",
      priceUsd: "5",
      transferPerMonthInGb: 50,
      isActive: true,
    },
    {
      bundleId: "medium_1_0",
      name: "Medium",
      priceUsd: "10.5",
      transferPerMonthInGb: 50,
      isActive: true,
    },
  ]);
  const call = aws.seen.find((r) => r.action === "GetDistributionBundles")!;
  expect(call.host).toBe("lightsail.us-east-1.amazonaws.com");
  expect(decodeURIComponent(aws.seen.find((r) => r.action === "AssumeRole")!.body)).toMatch(
    /role\/TcReader/,
  );
  for (const r of aws.seen) expect(r.action).toMatch(/^(Get|List|AssumeRole)/);
});

it("distributionBundles: a float artifact or a wrong type gives the empty price and false, never a guess (R4)", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetDistributionBundles",
    lightsailOk({
      bundles: [
        dist({ price: 0.1 + 0.2 }),
        dist({ bundleId: 7, name: 3, price: "5", transferPerMonthInGb: "50", isActive: "yes" }),
      ],
    }),
  );
  const out = await source.distributionBundles(POOL);
  expect(out[0]!.priceUsd).toBe("");
  expect(out[1]).toEqual({
    bundleId: "",
    name: "",
    priceUsd: "",
    transferPerMonthInGb: Number.NaN,
    isActive: false,
  });
});

it("distributionBundles: an answer without the bundles list fails closed", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetDistributionBundles", lightsailOk({}));
  await expect(source.distributionBundles(POOL)).rejects.toMatchObject({
    reason: "catalog_response_invalid",
  });
});

it("distributionBundles: an AWS error is an AwsError", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetDistributionBundles",
    lightsailError(500, "ServiceException", "raw aws text 210987654321"),
  );
  await expect(source.distributionBundles(POOL)).rejects.toBeInstanceOf(AwsError);
});

it("databaseBlueprints: follows nextPageToken, reads in the asked Region and keeps engine and version as text", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetRelationalDatabaseBlueprints",
    lightsailOk({ blueprints: [dbp()], nextPageToken: "p2" }),
    lightsailOk({
      blueprints: [
        dbp({
          blueprintId: "mysql_8_0",
          engine: "mysql",
          engineVersion: "8.0.36",
          isEngineDefault: false,
        }),
      ],
    }),
  );
  const out = await source.databaseBlueprints(POOL, "ap-southeast-1");
  expect(out).toEqual([
    {
      blueprintId: "postgres_16",
      engine: "postgres",
      engineVersion: "16.4",
      engineDescription: "PostgreSQL",
      engineVersionDescription: "PostgreSQL 16.4-R1",
      isEngineDefault: true,
    },
    {
      blueprintId: "mysql_8_0",
      engine: "mysql",
      engineVersion: "8.0.36",
      engineDescription: "PostgreSQL",
      engineVersionDescription: "PostgreSQL 16.4-R1",
      isEngineDefault: false,
    },
  ]);
  const calls = aws.seen.filter((r) => r.action === "GetRelationalDatabaseBlueprints");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.host).toBe("lightsail.ap-southeast-1.amazonaws.com");
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ pageToken: "p2" });
});

it("databaseBlueprints: a wrong field type becomes null or false", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetRelationalDatabaseBlueprints",
    lightsailOk({
      blueprints: [dbp({ blueprintId: 1, engine: ["x"], engineVersion: 16, isEngineDefault: "y" })],
    }),
  );
  const [b] = await source.databaseBlueprints(POOL, "ap-southeast-1");
  expect(b).toMatchObject({
    blueprintId: "",
    engine: null,
    engineVersion: null,
    isEngineDefault: false,
  });
});

it("databaseBlueprints: a token that never ends fails the scope instead of looping", async () => {
  const { aws, source } = setup({ maxPages: 2 });
  aws.on(
    "lightsail",
    "GetRelationalDatabaseBlueprints",
    lightsailOk({ blueprints: [dbp()], nextPageToken: "again" }),
  );
  await expect(source.databaseBlueprints(POOL, "ap-southeast-1")).rejects.toMatchObject({
    reason: "catalog_pages_exceeded",
  });
});

// WPU-X20. GetContainerServicePowers answers { powers: [{ powerId, name, price, cpuCount, ramSizeInGb, isActive }] }
// (API reference, ContainerServicePower): name "nano", powerId "nano-1", price a number of USD per month.
it("containerPowers: reads GetContainerServicePowers in the asked Region, price as decimal text", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetContainerServicePowers",
    lightsailOk({
      powers: [
        {
          powerId: "nano-1",
          name: "nano",
          price: 7,
          cpuCount: 0.25,
          ramSizeInGb: 0.5,
          isActive: true,
        },
        {
          powerId: "micro-1",
          name: "micro",
          price: 10,
          cpuCount: 0.25,
          ramSizeInGb: 1,
          isActive: false,
        },
      ],
    }),
  );
  const out = await source.containerPowers(POOL, "ap-southeast-1");
  expect(out).toEqual([
    {
      powerId: "nano-1",
      name: "nano",
      priceUsd: "7",
      cpuCount: 0.25,
      ramSizeInGb: 0.5,
      isActive: true,
    },
    {
      powerId: "micro-1",
      name: "micro",
      priceUsd: "10",
      cpuCount: 0.25,
      ramSizeInGb: 1,
      isActive: false,
    },
  ]);
});

it("containerPowers: an answer without the powers list fails closed, an AWS error is an AwsError", async () => {
  const first = setup();
  first.aws.on("lightsail", "GetContainerServicePowers", lightsailOk({}));
  await expect(first.source.containerPowers(POOL, "us-east-1")).rejects.toMatchObject({
    reason: "catalog_response_invalid",
  });
  const second = setup();
  second.aws.on(
    "lightsail",
    "GetContainerServicePowers",
    lightsailError(500, "ServiceException", "raw aws text 210987654321"),
  );
  await expect(second.source.containerPowers(POOL, "us-east-1")).rejects.toBeInstanceOf(AwsError);
});

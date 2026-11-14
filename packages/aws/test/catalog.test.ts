import { expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createCatalogSource, parseTldPrices, priceText } from "../catalog";
import { AwsError } from "../errors";
import {
  ASSUMED,
  PLANTED,
  assumeRoleOk,
  expectNoLeak,
  fakeAws,
  lightsailError,
  lightsailOk,
} from "./fake-aws";

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

const wire = (over: Record<string, unknown> = {}) => ({
  bundleId: "nano_3_0",
  name: "Nano",
  cpuCount: 2,
  ramSizeInGb: 0.5,
  diskSizeInGb: 20,
  transferPerMonthInGb: 1024,
  price: 5,
  publicIpv4AddressCount: 1,
  supportedPlatforms: ["LINUX_UNIX"],
  isActive: true,
  instanceType: "nano",
  ...over,
});
const priceOf = async (price: unknown) => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetBundles", lightsailOk({ bundles: [wire({ price })] }));
  const [b] = await source.instanceBundles(POOL, "ap-southeast-1");
  return b!.priceUsd;
};

it("follows nextPageToken and returns every bundle in order", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetBundles",
    lightsailOk({ bundles: [wire({ bundleId: "a_1" })], nextPageToken: "p2" }),
    lightsailOk({ bundles: [wire({ bundleId: "b_1" })] }),
  );
  const out = await source.instanceBundles(POOL, "ap-southeast-1");
  expect(out.map((b) => b.bundleId)).toEqual(["a_1", "b_1"]);
  const calls = aws.seen.filter((r) => r.action === "GetBundles");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ includeInactive: true });
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ includeInactive: true, pageToken: "p2" });
});

it("maps a bundle field by field and keeps the RAM as a number", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetBundles", lightsailOk({ bundles: [wire()] }));
  const [b] = await source.instanceBundles(POOL, "ap-southeast-1");
  expect(b).toEqual({
    bundleId: "nano_3_0",
    name: "Nano",
    cpuCount: 2,
    ramSizeInGb: 0.5,
    diskSizeInGb: 20,
    transferPerMonthInGb: 1024,
    priceUsd: "5",
    publicIpv4AddressCount: 1,
    supportedPlatforms: ["LINUX_UNIX"],
    isActive: true,
    instanceType: "nano",
    power: null,
  });
});

it("turns a float price into plain text, or into the empty text when it is not plain (R4)", async () => {
  expect(await priceOf(3.5)).toBe("3.5");
  expect(await priceOf(5)).toBe("5");
  expect(await priceOf(0.1 + 0.2)).toBe("");
  expect(await priceOf(-1)).toBe("");
  expect(await priceOf(Number.NaN)).toBe("");
  expect(await priceOf("5")).toBe("");
  expect(await priceOf(null)).toBe("");
  expect(await priceOf(1e-7)).toBe("");
  expect(await priceOf(1e21)).toBe("");
});

it("priceText is the one place a price leaves the float", () => {
  expect(priceText(3.5)).toBe("3.5");
  expect(priceText(0)).toBe("0");
  expect(priceText(12.34)).toBe("12.34");
  expect(priceText(Infinity)).toBeNull();
  expect(priceText(undefined)).toBeNull();
});

it("a wrong field type makes the bundle one that the mapping refuses, never a guessed default", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetBundles",
    lightsailOk({
      bundles: [
        wire({ cpuCount: "2", bundleId: 7, supportedPlatforms: "LINUX_UNIX", isActive: "yes" }),
      ],
    }),
  );
  const [b] = await source.instanceBundles(POOL, "ap-southeast-1");
  expect(Number.isNaN(b!.cpuCount)).toBe(true);
  expect(b!.bundleId).toBe("");
  expect(b!.supportedPlatforms).toEqual([]);
  expect(b!.isActive).toBe(false);
});

it("signs with TcReader in the asked Region and sends only read calls", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetBundles", lightsailOk({ bundles: [wire()] }));
  await source.instanceBundles(POOL, "ap-south-1");
  const sts = aws.seen.find((r) => r.action === "AssumeRole")!;
  expect(decodeURIComponent(sts.body)).toMatch(/role\/TcReader/);
  expect(aws.seen.find((r) => r.action === "GetBundles")!.host).toBe(
    "lightsail.ap-south-1.amazonaws.com",
  );
  for (const r of aws.seen) expect(r.action).toMatch(/^(Get|List|AssumeRole)/);
});

it("a page token that never ends stops after maxPages with an error that names nothing", async () => {
  const { aws, source } = setup({ maxPages: 3 });
  aws.on("lightsail", "GetBundles", lightsailOk({ bundles: [wire()], nextPageToken: "same" }));
  const error = await source.instanceBundles(POOL, "ap-southeast-1").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "internal", reason: "catalog_pages_exceeded" });
  expect(aws.seen.filter((r) => r.action === "GetBundles")).toHaveLength(3);
  expectNoLeak(error);
  for (const p of PLANTED) expect((error as Error).message).not.toContain(p);
});

it.each([[{}], [{ bundles: "x" }], [{ bundles: null }]])(
  "a body that is not a list of bundles (%j) fails the whole scope",
  async (body) => {
    const { aws, source } = setup();
    aws.on("lightsail", "GetBundles", lightsailOk(body));
    await expect(source.instanceBundles(POOL, "ap-southeast-1")).rejects.toMatchObject({
      name: "AwsError",
      code: "internal",
      reason: "catalog_response_invalid",
    });
  },
);

it("an entry that is not an object fails the whole scope", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetBundles", lightsailOk({ bundles: [wire(), "x"] }));
  await expect(source.instanceBundles(POOL, "ap-southeast-1")).rejects.toMatchObject({
    reason: "catalog_response_invalid",
  });
});

it("AccessDenied arrives as an AwsError with code forbidden and no AWS text", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetBundles",
    lightsailError(403, "AccessDeniedException", "User: arn:aws:sts::210987654321:assumed-role/x"),
  );
  const error = await source.instanceBundles(POOL, "ap-southeast-1").catch((e: unknown) => e);
  expect(error).toMatchObject({ name: "AwsError", code: "forbidden", operation: "GetBundles" });
  expectNoLeak(error);
});

it("TcReader is a read role: a 5xx and a throttle are each sent 3 times, no more (settings of WP4-T1)", async () => {
  const a = setup();
  a.aws.on("lightsail", "GetBundles", lightsailError(500, "ServiceException", "internal"));
  await expect(a.source.instanceBundles(POOL, "ap-southeast-1")).rejects.toMatchObject({
    code: "upstream_unavailable",
  });
  expect(a.aws.seen.filter((r) => r.action === "GetBundles")).toHaveLength(3);

  const b = setup();
  b.aws.on("lightsail", "GetBundles", lightsailError(400, "ThrottlingException", "Rate exceeded"));
  await expect(b.source.instanceBundles(POOL, "ap-southeast-1")).rejects.toMatchObject({
    code: "rate_limited",
  });
  expect(b.aws.seen.filter((r) => r.action === "GetBundles")).toHaveLength(3);
}, 15_000);

it("a Region outside the three is refused before any call", async () => {
  const { aws, source } = setup();
  await expect(source.instanceBundles(POOL, "eu-west-1" as never)).rejects.toMatchObject({
    reason: "region_not_allowed",
  });
  expect(aws.seen).toHaveLength(0);
});

// WPU-X10: tldPrices reads ListPrices of Route 53 Domains in the tc-dns account with TcDnsReader, page by page.
const DNS = { awsAccountId: "123456789012", externalId: "tc-ext-11aa22" };

it("tldPrices follows NextPageMarker with TcDnsReader and keeps the prices as text", async () => {
  const { aws, source } = setup();
  aws.on(
    "route53domains",
    "ListPrices",
    lightsailOk({
      Prices: [
        {
          Name: "com",
          RegistrationPrice: { Price: 15, Currency: "USD" },
          RenewalPrice: { Price: 15, Currency: "USD" },
          TransferPrice: { Price: 15, Currency: "USD" },
        },
      ],
      NextPageMarker: "page-2",
    }),
    lightsailOk({
      Prices: [{ Name: "xyz", RegistrationPrice: { Price: 13.5, Currency: "USD" } }],
    }),
  );
  expect(await source.tldPrices(DNS)).toEqual([
    {
      tld: "com",
      registrationUsd: "15",
      renewalUsd: "15",
      transferUsd: "15",
      needsExtraParams: false,
    },
    {
      tld: "xyz",
      registrationUsd: "13.5",
      renewalUsd: null,
      transferUsd: null,
      needsExtraParams: true,
    },
  ]);
  const calls = aws.seen.filter((r) => r.service === "route53domains");
  expect(calls).toHaveLength(2);
  expect(calls[0]!.body).not.toContain("page-2");
  expect(calls[1]!.body).toContain("page-2");
  expect(calls[0]!.host).toBe("route53domains.us-east-1.amazonaws.com");
  const sts = aws.seen.find((r) => r.service === "sts")!;
  expect(sts.body).toContain("TcDnsReader");
  expect(sts.body).not.toContain("TcDnsProvisioner");
});

it("tldPrices refuses a malformed page and maps an access denied without AWS text (R14, R16)", async () => {
  const bad = setup();
  bad.aws.on("route53domains", "ListPrices", lightsailOk({ Prices: "nope" }));
  await expect(bad.source.tldPrices(DNS)).rejects.toMatchObject({
    reason: "catalog_response_invalid",
  });
  const denied = setup();
  denied.aws.on(
    "route53domains",
    "ListPrices",
    lightsailError(
      403,
      "AccessDeniedException",
      "User: arn:aws:sts::123456789012:assumed-role/TcDnsReader/x is not authorized",
    ),
  );
  const error = await denied.source.tldPrices(DNS).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AwsError);
  expect(error).toMatchObject({ code: "forbidden" });
  expectNoLeak(error);
});

it("tldPrices refuses a bad account reference before any call", async () => {
  const { aws, source } = setup();
  await expect(
    source.tldPrices({ awsAccountId: "tc-dns", externalId: "tc-dns" }),
  ).rejects.toMatchObject({ reason: "account_ref_invalid" });
  expect(aws.seen).toHaveLength(0);
});

// The TLD price parser is pure and has no SDK type (tld-prices.ts). VERIFY the real ListPrices shape at the
// first staging sync (WPU-X10).
it("parseTldPrices keeps USD prices as text, drops other currencies and bad TLD names", () => {
  const page = {
    Prices: [
      {
        Name: "com",
        RegistrationPrice: { Price: 12, Currency: "USD" },
        RenewalPrice: { Price: 14.5, Currency: "USD" },
        TransferPrice: { Price: 12, Currency: "USD" },
      },
      { Name: "ORG", RegistrationPrice: { Price: 10, Currency: "EUR" } },
      { Name: "bad tld!", RegistrationPrice: { Price: 1, Currency: "USD" } },
      { Name: "co.uk", RegistrationPrice: { Price: 0.1 + 0.2, Currency: "USD" } },
    ],
    NextPageMarker: "m2",
  };
  const out = parseTldPrices(page);
  expect(out.next).toBe("m2");
  expect(out.prices.map((p) => p.tld)).toEqual(["com", "org", "co.uk"]);
  expect(out.prices[0]).toMatchObject({
    registrationUsd: "12",
    renewalUsd: "14.5",
    transferUsd: "12",
  });
  expect(out.prices[1]).toMatchObject({ registrationUsd: null, renewalUsd: null });
  expect(out.prices[2]!.registrationUsd).toBeNull();
});

// WPU-Z19 (open point 4 answered): DomainPrice has no field that marks extra parameters (API_domains_DomainPrice).
// Only the reviewed allowlist (com, net, org: not in the ExtraParam reference, no restriction on their Route 53
// pages) goes without review; every other TLD, well-formed or not, goes to the admin step of spec 12 (R16).
it("parseTldPrices: only the reviewed TLDs skip review; co.uk, ca, xyz and everything else need it", () => {
  const usd = { Price: 12, Currency: "USD" };
  const out = parseTldPrices({
    Prices: [
      { Name: "com", RegistrationPrice: usd },
      { Name: "NET", RegistrationPrice: usd },
      { Name: "org", RegistrationPrice: usd },
      { Name: "co.uk", RegistrationPrice: usd },
      { Name: "ca", RegistrationPrice: usd },
      { Name: "it", RegistrationPrice: usd },
      { Name: "xyz", RegistrationPrice: usd },
      { Name: "info" },
    ],
  });
  const flag = (tld: string) => out.prices.find((p) => p.tld === tld)!.needsExtraParams;
  expect(flag("com")).toBe(false);
  expect(flag("net")).toBe(false);
  expect(flag("org")).toBe(false);
  for (const tld of ["co.uk", "ca", "it", "xyz", "info"]) expect(flag(tld), tld).toBe(true);
  expect(() => parseTldPrices({})).toThrow(/catalog_response_invalid/);
});

// WPU-G3: GetBlueprints, the images of the Linux create wizard.
const bpWire = (over: Record<string, unknown> = {}) => ({
  blueprintId: "ubuntu_24_04",
  name: "Ubuntu",
  group: "ubuntu",
  type: "os",
  version: "24.04 LTS",
  platform: "LINUX_UNIX",
  isActive: true,
  description: "Free text that is never read",
  ...over,
});

it("blueprints: follows nextPageToken, asks for inactive images too, and maps field by field", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetBlueprints",
    lightsailOk({ blueprints: [bpWire()], nextPageToken: "p2" }),
    lightsailOk({
      blueprints: [bpWire({ blueprintId: "wordpress", type: "app", minPower: 1000 })],
    }),
  );
  const out = await source.instanceBlueprints(POOL, "ap-southeast-1");
  expect(out.map((b) => b.blueprintId)).toEqual(["ubuntu_24_04", "wordpress"]);
  expect(out[0]).toEqual({
    blueprintId: "ubuntu_24_04",
    name: "Ubuntu",
    type: "os",
    group: "ubuntu",
    version: "24.04 LTS",
    platform: "LINUX_UNIX",
    isActive: true,
    minPower: null,
  });
  // WPU-G10: minPower is read as the number AWS sends, and anything else is null
  expect(out[1]).toMatchObject({ blueprintId: "wordpress", minPower: 1000 });
  const calls = aws.seen.filter((r) => r.action === "GetBlueprints");
  expect(calls).toHaveLength(2);
  expect(JSON.parse(calls[0]!.body)).toMatchObject({ includeInactive: true });
  expect(JSON.parse(calls[1]!.body)).toMatchObject({ includeInactive: true, pageToken: "p2" });
});

it("blueprints: signs with TcReader in the asked Region and sends only read calls", async () => {
  const { aws, source } = setup();
  aws.on("lightsail", "GetBlueprints", lightsailOk({ blueprints: [bpWire()] }));
  await source.instanceBlueprints(POOL, "ap-south-1");
  const sts = aws.seen.find((r) => r.action === "AssumeRole")!;
  expect(decodeURIComponent(sts.body)).toMatch(/role\/TcReader/);
  expect(aws.seen.find((r) => r.action === "GetBlueprints")!.host).toBe(
    "lightsail.ap-south-1.amazonaws.com",
  );
  for (const r of aws.seen) expect(r.action).toMatch(/^(Get|List|AssumeRole)/);
});

it("blueprints: a wrong field type becomes null or false, never a guessed default", async () => {
  const { aws, source } = setup();
  aws.on(
    "lightsail",
    "GetBlueprints",
    lightsailOk({
      blueprints: [
        bpWire({
          blueprintId: 7,
          name: 5,
          type: ["os"],
          isActive: "yes",
          version: 1,
          minPower: "1000",
        }),
      ],
    }),
  );
  const [b] = await source.instanceBlueprints(POOL, "ap-southeast-1");
  expect(b).toMatchObject({
    blueprintId: "",
    name: "",
    type: null,
    version: null,
    isActive: false,
    minPower: null,
  });
});

it.each([[{}], [{ blueprints: "x" }], [{ blueprints: null }]])(
  "blueprints: a body that is not a list (%j) fails the whole scope",
  async (body) => {
    const { aws, source } = setup();
    aws.on("lightsail", "GetBlueprints", lightsailOk(body));
    await expect(source.instanceBlueprints(POOL, "ap-southeast-1")).rejects.toMatchObject({
      name: "AwsError",
      reason: "catalog_response_invalid",
    });
  },
);

it("blueprints: a page token that never ends stops after maxPages", async () => {
  const { aws, source } = setup({ maxPages: 2 });
  aws.on("lightsail", "GetBlueprints", lightsailOk({ blueprints: [bpWire()], nextPageToken: "s" }));
  await expect(source.instanceBlueprints(POOL, "ap-southeast-1")).rejects.toMatchObject({
    code: "internal",
    reason: "catalog_pages_exceeded",
  });
  expect(aws.seen.filter((r) => r.action === "GetBlueprints")).toHaveLength(2);
});

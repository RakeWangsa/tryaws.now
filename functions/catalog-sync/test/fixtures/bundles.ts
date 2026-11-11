// SHAPE OF a real Lightsail GetBundles answer (field names of the AWS SDK reference). This is NOT real AWS
// output and nothing here claims it is: the real answer is a manual VERIFY step in tc-pool-dev. The `price`
// and `ramSizeInGb` fields are floats, as in the SDK model. The fixtures go through the real
// `createCatalogSource` adapter with a fake client, so the float-to-text rule is exercised too.

export interface BundleItem {
  bundleId: string;
  name: string;
  instanceType: string;
  isActive: boolean;
  cpuCount: number;
  ramSizeInGb: number;
  diskSizeInGb: number;
  transferPerMonthInGb: number;
  price: number;
  power: number;
  publicIpv4AddressCount: number;
  supportedPlatforms: string[];
  supportedAppCategories: string[];
}

export function item(bundleId: string, over: Partial<BundleItem> = {}): BundleItem {
  return {
    bundleId,
    name: bundleId,
    instanceType: "nano",
    isActive: true,
    cpuCount: 2,
    ramSizeInGb: 0.5,
    diskSizeInGb: 20,
    transferPerMonthInGb: 1024,
    price: 5,
    power: 300,
    publicIpv4AddressCount: 1,
    supportedPlatforms: ["LINUX_UNIX"],
    supportedAppCategories: ["Operating System"],
    ...over,
  };
}

/** A Nano with IPv4 at 5 USD. */
export const NANO = item("nano_3_0");
/** An IPv6-only Nano at 3.5 USD: stored, never active. */
export const NANO_IPV6 = item("nano_ipv6_3_0", { price: 3.5, publicIpv4AddressCount: 0 });
/** A 2 GB plan at 10 USD. */
export const SMALL_2GB = item("small_3_0", {
  instanceType: "small",
  ramSizeInGb: 2,
  diskSizeInGb: 60,
  transferPerMonthInGb: 3072,
  price: 10,
  power: 700,
});
/** A Windows plan at 8 USD. */
export const WINDOWS_NANO = item("nano_win_3_0", {
  price: 8,
  supportedPlatforms: ["WINDOWS"],
  ramSizeInGb: 1,
});
/** AWS lists it, marks it not active. */
export const OLD_INACTIVE = item("old_1_0", { isActive: false, price: 7 });
/** A float artifact: 0.30000000000000004 can never be a price (R4). */
export const FLOAT_ARTIFACT = item("artifact_3_0", { price: 0.1 + 0.2 });
/** A negative price. */
export const NEGATIVE = item("negative_3_0", { price: -5 });

/** The usual answer of one Region. */
export const FULL_ANSWER: BundleItem[] = [
  NANO,
  NANO_IPV6,
  SMALL_2GB,
  WINDOWS_NANO,
  OLD_INACTIVE,
  FLOAT_ARTIFACT,
  NEGATIVE,
];
/** Of those, the ones that are stored: all but the two refused for their price. */
export const STORED_COUNT = 5;
/** Of those, the ones that are active (NANO, SMALL_2GB, WINDOWS_NANO). */
export const ACTIVE_COUNT = 3;

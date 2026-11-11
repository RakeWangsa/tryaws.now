import { expect, it } from "vitest";
import {
  ACCOUNT_REGION,
  ACCOUNT_WIDE_CODES,
  cellRegion,
  isCellKey,
  isReservedCell,
  REGION_PATTERN,
  reserveKey,
  ROLLING_WINDOW_CODES,
} from "../capacity-keys";
import { QUOTA_CODES } from "../schema/index";

it("an account-wide quota lives on the Region global, every other quota on its Region", () => {
  expect(ACCOUNT_REGION).toBe("global");
  expect(cellRegion("bucket", "ap-southeast-1")).toBe("global");
  expect(cellRegion("distribution", "us-east-1")).toBe("global");
  expect(cellRegion("static_ip", "ap-southeast-1")).toBe("ap-southeast-1");
});
it("isCellKey takes a quota with its kind of Region and nothing else", () => {
  expect(isCellKey("static_ip", "ap-south-1")).toBe(true);
  expect(isCellKey("bucket", "global")).toBe(true);
  for (const [code, region] of [
    ["bucket", "ap-south-1"],
    ["static_ip", "global"],
    ["gpu", "ap-south-1"],
    ["static_ip", "Singapore"],
  ] as const) {
    expect(isCellKey(code, region), `${code} ${region}`).toBe(false);
  }
});
it("the special codes are quota codes of the schema", () => {
  for (const code of [...ACCOUNT_WIDE_CODES, ...ROLLING_WINDOW_CODES]) {
    expect(QUOTA_CODES).toContain(code);
  }
  expect([...ACCOUNT_WIDE_CODES]).toEqual(["bucket", "distribution"]);
  expect([...ROLLING_WINDOW_CODES]).toEqual(["certificate_365d"]);
});
it("the key of a reserve setting is capacity.reserve.<quota code>", () => {
  expect(reserveKey("instance_vcpu")).toBe("capacity.reserve.instance_vcpu");
});
it("REGION_PATTERN takes the three Regions of the pool accounts and no look-alike", () => {
  for (const ok of ["ap-southeast-1", "ap-south-1", "us-east-1"]) {
    expect(REGION_PATTERN.test(ok), ok).toBe(true);
  }
  for (const bad of [
    "global",
    "Singapore",
    "ap-southeast",
    "AP-SOUTHEAST-1",
    "ap-southeast-10",
    " ap-south-1",
  ]) {
    expect(REGION_PATTERN.test(bad), bad).toBe(false);
  }
});
it("isReservedCell takes a whole cell and nothing else", () => {
  expect(isReservedCell({ quotaCode: "static_ip", region: "ap-south-1", amount: 1 })).toBe(true);
  expect(isReservedCell({ quotaCode: "bucket", region: "global", amount: 3 })).toBe(true);
  expect(isReservedCell({ quotaCode: "bucket", region: "global", amount: 1_000_000 })).toBe(true);
  const bad = [
    null,
    "x",
    {},
    { quotaCode: "gpu", region: "ap-south-1", amount: 1 },
    { quotaCode: "static_ip", region: "x", amount: 1 },
    { quotaCode: "static_ip", region: "ap-south-1", amount: 0 },
    { quotaCode: "static_ip", region: "ap-south-1", amount: 1.5 },
    { quotaCode: "static_ip", region: "ap-south-1" },
    { quotaCode: "static_ip", region: "ap-south-1", amount: 1_000_001 },
    { quotaCode: "static_ip", region: "global", amount: 1 },
    { quotaCode: "bucket", region: "ap-south-1", amount: 1 },
  ];
  for (const b of bad) expect(isReservedCell(b), JSON.stringify(b)).toBe(false);
});

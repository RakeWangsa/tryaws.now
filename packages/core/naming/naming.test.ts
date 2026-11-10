import { expect, it } from "vitest";
import {
  AWS_NAME_TYPES,
  NamingError,
  TAG_KEYS,
  TC_ENVS,
  awsResourceName,
  resourceTags,
} from "./index";

const ID = "01a1c79b-17da-76c9-9766-a84e943a8987";
const CUSTOMER = "01a1c79b-0000-7000-8000-00000000c001";
const ORDER = "01a1c79b-0000-7000-8000-00000000a001";
const HOSTILE = [
  "",
  "My Server",
  "tc-instance-0123456789abcdef",
  "$(id)",
  "`id`",
  "a;rm -rf /",
  "{{7*7}}",
  "../../etc/passwd",
  "ক্লাউড সার্ভার",
  "x\ny",
  "01A1C79B-17DA-76C9-9766-A84E943A8987",
  ID + " ",
  "01a1c79b17da76c99766a84e943a8987",
  "x".repeat(300),
];

it("names are tc-<type>-<the last 16 hex digits of the id>", () => {
  expect(awsResourceName("instance", ID)).toBe("tc-instance-9766a84e943a8987");
  expect(awsResourceName("bucket", ID)).toBe("tc-bucket-9766a84e943a8987");
});

it("has exactly the name types of this plan", () => {
  expect([...AWS_NAME_TYPES]).toEqual([
    "instance",
    "staticip",
    "keypair",
    "snapshot",
    "disk",
    "database",
    "lb",
    "lbcert",
    "bucket",
    "container",
    "cdn",
    "cert",
  ]);
});

it.each(AWS_NAME_TYPES)(
  "a %s name is lowercase, starts with a letter and has at most 29 characters",
  (type) => {
    const name = awsResourceName(type, ID);
    expect(name).toMatch(/^tc-[a-z]{2,9}-[0-9a-f]{16}$/);
    expect(name.length).toBe(20 + type.length);
    expect(name.length).toBeLessThanOrEqual(29);
  },
);

it.each(HOSTILE)("customer text never becomes a name: %j is refused and not repeated", (bad) => {
  expect(() => awsResourceName("instance", bad)).toThrow(NamingError);
  expect(() => awsResourceName("instance", bad)).toThrow(/^naming: id is not a lowercase UUID$/);
});

it("refuses a type outside the list", () => {
  expect(() => awsResourceName("My Server" as never, ID)).toThrow(/^naming: type is not valid$/);
});

it("instance tags: env, customer, resource, order and os, in this order", () => {
  expect(
    resourceTags({
      env: "staging",
      customerId: CUSTOMER,
      resourceId: ID,
      orderId: ORDER,
      os: "windows",
    }),
  ).toEqual([
    { key: "tc:env", value: "staging" },
    { key: "tc:customer", value: CUSTOMER },
    { key: "tc:resource", value: ID },
    { key: "tc:order", value: ORDER },
    { key: "tc:os", value: "windows" },
  ]);
});

it("tags without os have no tc:os, and the keys are the five fixed ones", () => {
  const tags = resourceTags({
    env: "production",
    customerId: CUSTOMER,
    resourceId: ID,
    orderId: ORDER,
  });
  expect(tags.map((t) => t.key)).toEqual(["tc:env", "tc:customer", "tc:resource", "tc:order"]);
  expect(Object.values(TAG_KEYS)).toEqual([
    "tc:env",
    "tc:customer",
    "tc:resource",
    "tc:order",
    "tc:os",
  ]);
  expect([...TC_ENVS]).toEqual(["production", "staging"]);
});

it.each(HOSTILE)("customer text never becomes a tag value: %j", (bad) => {
  const ok = { env: "staging" as const, customerId: CUSTOMER, resourceId: ID, orderId: ORDER };
  for (const field of ["customerId", "resourceId", "orderId"] as const) {
    expect(() => resourceTags({ ...ok, [field]: bad })).toThrow(
      new RegExp(`^naming: ${field} is not a lowercase UUID$`),
    );
  }
});

it("refuses an env or os outside the lists", () => {
  const ok = { env: "staging" as const, customerId: CUSTOMER, resourceId: ID, orderId: ORDER };
  expect(() => resourceTags({ ...ok, env: "dev" as never })).toThrow(/^naming: env is not valid$/);
  expect(() => resourceTags({ ...ok, os: "Windows" as never })).toThrow(
    /^naming: os is not valid$/,
  );
});

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

const NEAR_MISSES = [ID + "\n", "\n" + ID, ID + "\r", ID.replace("0", "０"), `x${ID}x`];

it.each(NEAR_MISSES)("a value that only looks like the id is refused: %j", (bad) => {
  expect(() => awsResourceName("instance", bad)).toThrow(/^naming: id is not a lowercase UUID$/);
  const ok = { env: "staging" as const, customerId: CUSTOMER, resourceId: ID, orderId: ORDER };
  expect(() => resourceTags({ ...ok, customerId: bad })).toThrow(
    /^naming: customerId is not a lowercase UUID$/,
  );
});

const NOT_STRINGS = [
  { what: "an array that holds the id", value: [ID] },
  { what: "an object that prints as the id", value: { toString: () => ID } },
  { what: "a String object", value: new String(ID) },
  { what: "null", value: null },
  { what: "undefined", value: undefined },
  { what: "a number", value: 123 },
];

it.each(NOT_STRINGS)("$what is refused, although it may print as a valid id", ({ value }) => {
  expect(() => awsResourceName("instance", value as never)).toThrow(
    /^naming: id is not a lowercase UUID$/,
  );
  const ok = { env: "staging" as const, customerId: CUSTOMER, resourceId: ID, orderId: ORDER };
  expect(() => resourceTags({ ...ok, resourceId: value as never })).toThrow(
    /^naming: resourceId is not a lowercase UUID$/,
  );
});

it.each(["__proto__", "constructor", "toString", "hasOwnProperty", "Instance", "instance "])(
  "a type that is not in the list is refused: %j",
  (type) => {
    expect(() => awsResourceName(type as never, ID)).toThrow(/^naming: type is not valid$/);
  },
);

it("the name uses the last 16 hex digits of the id, not the first", () => {
  expect(awsResourceName("disk", "00000000-0000-7000-8000-00000000abcd")).toBe(
    "tc-disk-800000000000abcd",
  );
});

it("tags come only from the checked fields, and each call returns a new array", () => {
  const input = {
    env: "production" as const,
    customerId: CUSTOMER,
    resourceId: ID,
    orderId: ORDER,
    os: "linux" as const,
    name: "My Server",
  };
  const first = resourceTags(input);
  expect(first).toEqual([
    { key: "tc:env", value: "production" },
    { key: "tc:customer", value: CUSTOMER },
    { key: "tc:resource", value: ID },
    { key: "tc:order", value: ORDER },
    { key: "tc:os", value: "linux" },
  ]);
  first.push({ key: "x", value: "y" });
  expect(resourceTags(input)).toHaveLength(5);
});

it("the exported lists cannot be changed at run time", () => {
  expect(Object.isFrozen(AWS_NAME_TYPES)).toBe(true);
  expect(Object.isFrozen(TC_ENVS)).toBe(true);
  expect(Object.isFrozen(TAG_KEYS)).toBe(true);
  expect(() => (AWS_NAME_TYPES as unknown as string[]).push("evil")).toThrow(TypeError);
  expect(() => awsResourceName("evil" as never, ID)).toThrow(/^naming: type is not valid$/);
});

it("refuses an input that is not an object, with a NamingError and no value in the message", () => {
  for (const bad of [null, undefined, "x", 7]) {
    expect(() => resourceTags(bad as never)).toThrow(NamingError);
    expect(() => resourceTags(bad as never)).toThrow(/^naming: input is not valid$/);
  }
});

it("reads each field once, so a getter that changes between reads cannot get past the check", () => {
  const reads: Record<string, number> = {};
  const input = {};
  const shifting = (field: string, good: string, bad: string) =>
    Object.defineProperty(input, field, {
      enumerable: true,
      get() {
        reads[field] = (reads[field] ?? 0) + 1;
        return reads[field] === 1 ? good : bad;
      },
    });
  shifting("env", "staging", "<evil>");
  shifting("customerId", CUSTOMER, "My Server");
  shifting("resourceId", ID, "My Server");
  shifting("orderId", ORDER, "My Server");
  shifting("os", "linux", "Windows; rm -rf /");
  expect(resourceTags(input as never)).toEqual([
    { key: "tc:env", value: "staging" },
    { key: "tc:customer", value: CUSTOMER },
    { key: "tc:resource", value: ID },
    { key: "tc:order", value: ORDER },
    { key: "tc:os", value: "linux" },
  ]);
  expect(reads).toEqual({ env: 1, customerId: 1, resourceId: 1, orderId: 1, os: 1 });
});

import { inspect } from "node:util";
import { expect, it } from "vitest";
import { epsCredentials } from "../gateway";

// Fake values built at run time; nothing here is a real credential.
const secrets = {
  merchantId: "m".repeat(12),
  storeId: "s".repeat(12),
  username: "u".repeat(12),
  password: "p".repeat(12),
  hashKey: "h".repeat(12),
};

function make() {
  return epsCredentials({ mode: "sandbox", ...secrets });
}

it("prints none of the five secrets through JSON, a template, String, inspect or a console formatter", () => {
  const c = make();
  const outputs = [
    JSON.stringify(c),
    JSON.stringify({ wrapped: c }),
    `${c}`,
    String(c),
    inspect(c),
    inspect({ wrapped: c }, { depth: 5 }),
    inspect([c], { showHidden: true }),
  ];
  for (const out of outputs) {
    for (const v of Object.values(secrets)) expect(out).not.toContain(v);
    expect(out).toContain("[eps credentials]");
  }
});

it("still hands the values to the client that needs them", () => {
  const c = make();
  expect(c.hashKey).toBe(secrets.hashKey);
  expect(c.mode).toBe("sandbox");
});

it("is frozen and a copy of the input", () => {
  const input = { mode: "production" as const, ...secrets };
  const c = epsCredentials(input);
  expect(Object.isFrozen(c)).toBe(true);
  expect(c).not.toBe(input);
  expect(() => {
    (c as { password: string }).password = "x";
  }).toThrow();
});

it("refuses an empty credential or an unknown mode (fail closed)", () => {
  expect(() => epsCredentials({ mode: "sandbox", ...secrets, hashKey: "" })).toThrow();
  expect(() => epsCredentials({ mode: "sandbox", ...secrets, password: "" })).toThrow();
  expect(() => epsCredentials({ mode: "staging" as never, ...secrets })).toThrow();
});

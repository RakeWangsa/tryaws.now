// SST refuses a deploy when two components share a name, whatever their type ("Component name Web is
// not unique", deploy-staging run 43570181216, 2026-11-14: the customer Cognito client and the customer
// Next.js site were both "Web"). This pins unique names across every stack file.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const stacks = resolve(import.meta.dirname, "../../infra/stacks");

it("gives every SST component of infra/stacks a unique name", () => {
  const seen = new Map();
  const duplicates = [];
  for (const file of readdirSync(stacks).filter(
    (f) => f.endsWith(".ts") && !f.includes(".test."),
  )) {
    const text = readFileSync(join(stacks, file), "utf8");
    const pattern = /(?:new sst\.aws\.[A-Za-z0-9]+|\.addClient)\(\s*"([A-Za-z0-9]+)"/g;
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (seen.has(name)) duplicates.push(`${name} in ${seen.get(name)} and ${file}`);
      else seen.set(name, file);
    }
  }
  expect(seen.size).toBeGreaterThan(5);
  expect(duplicates).toEqual([]);
});

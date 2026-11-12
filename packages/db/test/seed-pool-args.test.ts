import { describe, expect, it } from "vitest";
import { parseSeedArgs } from "../seed-pool";

// The command line of scripts/seed-pool-account.mjs. Placeholder values only.
describe("parseSeedArgs", () => {
  const base = [
    "--stage",
    "staging",
    "--aws-account-id",
    "111111111111",
    "--external-id",
    "tc-ext-placeholder-1",
    "--name",
    "tc-pool-one",
  ];

  it("reads the flags, with the stage falling back to the STAGE variable", () => {
    expect(parseSeedArgs(base, {})).toEqual({
      stage: "staging",
      awsAccountId: "111111111111",
      externalId: "tc-ext-placeholder-1",
      name: "tc-pool-one",
    });
    expect(parseSeedArgs(base.slice(2), { STAGE: "local" })).toMatchObject({ stage: "local" });
  });

  it("reads tier, role ARN, the confirmation flag and a JSON object of limits", () => {
    const out = parseSeedArgs(
      [
        ...base,
        "--tier",
        "trusted",
        "--role-arn",
        "arn:aws:iam::111111111111:role/TcProvisioner",
        "--limits",
        '{"instance_vcpu":40}',
        "--confirm-production",
      ],
      {},
    );
    expect(out).toMatchObject({
      tier: "trusted",
      roleArn: "arn:aws:iam::111111111111:role/TcProvisioner",
      limits: { instance_vcpu: 40 },
      confirmProduction: true,
    });
  });

  it("refuses an unknown flag, a flag without a value, and limits that are not a JSON object", () => {
    expect(() => parseSeedArgs([...base, "--nope", "1"], {})).toThrow(/^seed-pool: /);
    expect(() => parseSeedArgs([...base, "--tier"], {})).toThrow(/^seed-pool: /);
    for (const bad of ["not json", "[1]", "3", "null"])
      expect(() => parseSeedArgs([...base, "--limits", bad], {}), bad).toThrow(/limits/);
  });
});

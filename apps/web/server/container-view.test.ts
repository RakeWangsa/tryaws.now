import { describe, expect, it } from "vitest";
import { containerConfigOf, deploymentFactsOf, runsOf } from "./container-view.ts";

describe("deploymentFactsOf", () => {
  const saved = {
    containers: {
      c2: { image: "redis:7", ports: { "6379": "TCP" } },
      c1: {
        image: "nginx:1.27",
        ports: { "80": "HTTP" },
        environment: { API_TOKEN: "super-secret-value", MODE: "prod" },
      },
    },
    publicEndpoint: { containerName: "c1", containerPort: 80, healthCheckPath: "/health" },
  };

  it("reads the saved deployment field by field and never returns an environment value (R14)", () => {
    const facts = deploymentFactsOf(saved);
    expect(facts).toEqual({
      containers: [
        {
          image: "nginx:1.27",
          ports: [{ port: 80, protocol: "HTTP" }],
          variables: ["API_TOKEN", "MODE"],
        },
        { image: "redis:7", ports: [{ port: 6379, protocol: "TCP" }], variables: [] },
      ],
      publicEndpoint: { port: 80, healthCheckPath: "/health" },
    });
    expect(JSON.stringify(facts)).not.toContain("super-secret-value");
    // The generated container names (c1..) are not returned either (R11).
    expect(JSON.stringify(facts)).not.toMatch(/"c1"|"c2"/);
  });

  it("is null for anything odd, so the page shows no deployment instead of a guess", () => {
    for (const odd of [null, 5, [], {}, { containers: [] }, { containers: { c1: { image: 5 } } }]) {
      expect(deploymentFactsOf(odd)).toBeNull();
    }
    expect(deploymentFactsOf({ containers: { c1: { image: "x" } } })).toEqual({
      containers: [{ image: "x", ports: [], variables: [] }],
      publicEndpoint: null,
    });
  });
});

describe("containerConfigOf", () => {
  it("shows the public address only when it is a plain host name (U6 exception)", () => {
    const url = "tc-container-9766a84e943a8987.abcd1234.ap-southeast-1.cs.amazonlightsail.com";
    expect(containerConfigOf({ displayName: "web", publicUrl: url }).publicUrl).toBe(url);
    for (const odd of ["<b>x</b>.example", "https://x.example/", "a b.example", "x", 5, null]) {
      expect(containerConfigOf({ publicUrl: odd }).publicUrl).toBeNull();
    }
  });

  it("ignores account ids and stored AWS names", () => {
    const facts = containerConfigOf({
      displayName: "web",
      accountId: "123456789012",
      awsName: "tc-container-0123456789abcdef",
    });
    expect(JSON.stringify(facts)).not.toMatch(/123456789012|tc-container/);
  });
});

describe("runsOf", () => {
  it("keeps the deployment requests only, with no payload", () => {
    const op = (kind: string, n: number) => ({
      id: `id${n}`,
      resourceId: "r",
      kind,
      state: "succeeded",
      step: null,
      needsApproval: false,
      createdAt: new Date(2026, 10, n),
    });
    const runs = runsOf([op("create", 1), op("deploy_containers", 2), op("scale_container", 3)]);
    expect(runs).toHaveLength(1);
    expect(Object.keys(runs[0] as object).sort()).toEqual([
      "createdAt",
      "id",
      "needsApproval",
      "state",
    ]);
  });
});

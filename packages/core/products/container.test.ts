import { describe, expect, it } from "vitest";
import { containerPlanFrom, parseContainerConfig, parseDeployment } from "./container";

const PRODUCT_ID = "0190bbbb-0000-7000-8000-000000000001";
const GOOD = { productId: PRODUCT_ID, region: "ap-southeast-1", displayName: "My API" };
const DEPLOY = {
  containers: [
    {
      image: "nginx:1.27",
      ports: [{ port: 80, protocol: "HTTP" }],
      environment: { MODE: "prod" },
      command: ["nginx", "-g", "daemon off;"],
    },
  ],
  publicEndpoint: { container: 0, port: 80, healthCheckPath: "/" },
};

describe("parseContainerConfig", () => {
  it("keeps the known fields only", () => {
    expect(parseContainerConfig({ ...GOOD, serviceName: "evil", power: "xlarge" })).toEqual({
      ok: true,
      value: GOOD,
    });
  });
  it("refuses bad input", () => {
    expect(parseContainerConfig({ productId: 1, region: "", displayName: "" })).toMatchObject({
      ok: false,
      fields: { productId: "invalid", region: "invalid", displayName: "invalid" },
    });
  });
});

describe("containerPlanFrom", () => {
  it("reads power from the catalog id and scale from the specs", () => {
    expect(containerPlanFrom("micro", { scale: 2 })).toEqual({ power: "micro", scale: 2 });
  });
  it("fails closed on a surprise", () => {
    expect(containerPlanFrom("huge", { scale: 1 })).toBeNull();
    expect(containerPlanFrom("nano", { scale: 0 })).toBeNull();
    expect(containerPlanFrom("nano", { scale: 21 })).toBeNull();
    expect(containerPlanFrom("nano", { scale: 1.5 })).toBeNull();
    expect(containerPlanFrom("nano", null)).toBeNull();
  });
});

describe("parseDeployment", () => {
  it("accepts a public image and generates the container names (R11)", () => {
    const r = parseDeployment(DEPLOY);
    expect(r).toEqual({
      ok: true,
      value: {
        containers: {
          c1: {
            image: "nginx:1.27",
            command: ["nginx", "-g", "daemon off;"],
            environment: { MODE: "prod" },
            ports: { "80": "HTTP" },
          },
        },
        publicEndpoint: { containerName: "c1", containerPort: 80, healthCheckPath: "/" },
      },
    });
  });
  it("accepts the public registries only", () => {
    for (const image of [
      "nginx",
      "library/nginx:latest",
      "ghcr.io/org/app:1",
      "quay.io/org/app@sha256:" + "a".repeat(64),
      "public.ecr.aws/nginx/nginx:stable",
    ]) {
      expect(parseDeployment({ containers: [{ image }] }).ok, image).toBe(true);
    }
  });
  it("refuses private registries, other schemes and odd input (no registry login exists)", () => {
    for (const image of [
      "123456789012.dkr.ecr.ap-south-1.amazonaws.com/app:1",
      ":service-name.app.1",
      "https://nginx",
      "nginx latest",
      "NGINX",
      "",
      "a".repeat(300),
      "evil.example.com/app:1",
    ]) {
      expect(parseDeployment({ containers: [{ image }] }).ok, image).toBe(false);
    }
    expect(parseDeployment({ containers: [] }).ok).toBe(false);
    expect(parseDeployment({}).ok).toBe(false);
    expect(
      parseDeployment({ containers: Array.from({ length: 11 }, () => ({ image: "nginx" })) }).ok,
    ).toBe(false);
  });
  it("bounds ports, environment, command and endpoint", () => {
    const base = { image: "nginx" };
    const bad = [
      { ...base, ports: [{ port: 0, protocol: "HTTP" }] },
      { ...base, ports: [{ port: 80, protocol: "SCTP" }] },
      { ...base, environment: { "bad key": "x" } },
      { ...base, environment: { K: "a\u0000b" } },
      { ...base, environment: { K: 1 } },
      { ...base, command: ["x", 1] },
    ];
    for (const c of bad) expect(parseDeployment({ containers: [c] }).ok).toBe(false);
    expect(
      parseDeployment({ containers: [base], publicEndpoint: { container: 3, port: 80 } }).ok,
    ).toBe(false);
    // the endpoint must point at a port the container declares
    expect(
      parseDeployment({ containers: [base], publicEndpoint: { container: 0, port: 80 } }).ok,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { parseDeployment } from "./container";
import {
  checkedContainerCertificateDomain,
  deploymentHistoryEntry,
  parsePortList,
  withPublicEndpoint,
} from "./container-console";

// WPU-G8: pure rules of the container service console. Customer text (ports, endpoint, domain) is
// checked here and travels as a value, never as an AWS name or tag (R11).

describe("parsePortList", () => {
  it("reads numbers with an optional protocol and the default for the rest", () => {
    expect(parsePortList("80, 8080/TCP\n53/udp", "HTTP")).toEqual([
      { port: 80, protocol: "HTTP" },
      { port: 8080, protocol: "TCP" },
      { port: 53, protocol: "UDP" },
    ]);
    expect(parsePortList("", "HTTP")).toEqual([]);
    expect(parsePortList("  ", "HTTP")).toEqual([]);
  });

  it("refuses a bad number, a bad protocol, a duplicate and too many ports", () => {
    for (const bad of ["0", "65536", "80/FTP", "eighty", "80/", "-1", "1e3", "80, 80", "8 0"]) {
      expect(parsePortList(bad, "HTTP"), bad).toBeNull();
    }
    expect(parsePortList("80", "FTP")).toBeNull();
    const many = Array.from({ length: 21 }, (_, i) => String(1000 + i)).join(",");
    expect(parsePortList(many, "HTTP")).toBeNull();
  });
});

const saved = {
  containers: {
    c1: {
      image: "nginx:1.27",
      command: ["nginx", "-g", "daemon off;"],
      environment: { MODE: "prod" },
      ports: { "80": "HTTP", "8080": "TCP" },
    },
    c2: { image: "redis:7", ports: { "6379": "TCP" } },
  },
  publicEndpoint: { containerName: "c1", containerPort: 80, healthCheckPath: "/health" },
};

describe("withPublicEndpoint", () => {
  it("turns the saved deployment into the input of parseDeployment with the new endpoint", () => {
    const out = withPublicEndpoint(saved, { container: 1, port: 8080, healthCheckPath: "/up" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // the containers (with their environment values, kept server side) are the saved ones
    expect(out.value).toMatchObject({
      containers: [
        {
          image: "nginx:1.27",
          command: ["nginx", "-g", "daemon off;"],
          environment: { MODE: "prod" },
          ports: [
            { port: 80, protocol: "HTTP" },
            { port: 8080, protocol: "TCP" },
          ],
        },
        { image: "redis:7", ports: [{ port: 6379, protocol: "TCP" }] },
      ],
      publicEndpoint: { container: 0, port: 8080, healthCheckPath: "/up" },
    });
    // and the result is accepted by the one parser of the adapter
    const parsed = parseDeployment(out.value);
    expect(parsed.ok && parsed.value.publicEndpoint).toEqual({
      containerName: "c1",
      containerPort: 8080,
      healthCheckPath: "/up",
    });
  });

  it("removes the endpoint when asked, and keeps no health path without one", () => {
    const none = withPublicEndpoint(saved, null);
    expect(none.ok && (none.value as Record<string, unknown>).publicEndpoint).toBeUndefined();
    const second = withPublicEndpoint(saved, { container: 2, port: 6379 });
    expect(second.ok && (second.value as { publicEndpoint: object }).publicEndpoint).toEqual({
      container: 1,
      port: 6379,
    });
  });

  it("refuses a port the container does not declare, a bad container number or path, and a missing deployment (R16)", () => {
    expect(withPublicEndpoint(saved, { container: 1, port: 9999 }).ok).toBe(false);
    expect(withPublicEndpoint(saved, { container: 3, port: 80 }).ok).toBe(false);
    expect(withPublicEndpoint(saved, { container: 0, port: 80 }).ok).toBe(false);
    expect(withPublicEndpoint(saved, { container: 1, port: 80, healthCheckPath: "up" }).ok).toBe(
      false,
    );
    expect(withPublicEndpoint(null, { container: 1, port: 80 }).ok).toBe(false);
    expect(withPublicEndpoint({ containers: {} }, null).ok).toBe(false);
    expect(
      withPublicEndpoint({ containers: { c1: { image: "private.example.com/x" } } }, null).ok,
    ).toBe(false);
  });
});

describe("deploymentHistoryEntry", () => {
  it("keeps the images, the container count and whether an endpoint exists, and never the environment", () => {
    const parsed = parseDeployment({
      containers: [
        {
          image: "nginx",
          environment: { SECRET: "s3cr3t" },
          ports: [{ port: 80, protocol: "HTTP" }],
        },
      ],
      publicEndpoint: { container: 0, port: 80 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const entry = deploymentHistoryEntry(parsed.value, new Date("2026-11-12T10:00:00Z"));
    expect(entry).toEqual({
      at: "2026-11-12T10:00:00.000Z",
      images: ["nginx"],
      endpoint: true,
    });
    expect(JSON.stringify(entry)).not.toContain("s3cr3t");
  });
});

describe("checkedContainerCertificateDomain", () => {
  it("is the plain domain rule of the console", () => {
    expect(checkedContainerCertificateDomain(" App.Example.com ")).toBe("app.example.com");
    for (const bad of [
      "localhost",
      "*.example.com",
      "a b.com",
      7,
      null,
      "x".repeat(300) + ".com",
    ]) {
      expect(checkedContainerCertificateDomain(bad)).toBeNull();
    }
  });
});

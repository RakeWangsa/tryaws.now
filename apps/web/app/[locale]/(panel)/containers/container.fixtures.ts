import type {
  ContainerConfiguratorScreen,
  ContainerDetail,
  ContainerPlanOption,
  ContainerRow,
} from "../../../../server/container-view.ts";

// Rows for the render tests of the container service screens (never imported by a page).

export const SERVICE_ID = "0190aaaa-0000-7000-8000-0000000000d1";
export const PLAN_NANO = "0190aaaa-0000-7000-8000-0000000000e1";
export const PLAN_MICRO = "0190aaaa-0000-7000-8000-0000000000e2";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";
export const PUBLIC_URL =
  "tc-container-80000000000000d1.abcd1234.ap-southeast-1.cs.amazonlightsail.com";
/** A value that must never reach any rendered state (R14). */
export const ENV_SECRET = "super-secret-env-value";

export const noopAction = async () => ({});

export function plan(over: Partial<ContainerPlanOption> = {}): ContainerPlanOption {
  return {
    id: PLAN_NANO,
    region: "ap-southeast-1",
    power: "nano",
    scale: 1,
    priceMinor: 90000n,
    vcpus: 0.25,
    ramGb: 0.5,
    ...over,
  };
}

export function configurator(
  over: Partial<Extract<ContainerConfiguratorScreen, { state: "ready" }>> = {},
): ContainerConfiguratorScreen {
  return {
    state: "ready",
    plans: [plan(), plan({ id: PLAN_MICRO, power: "micro", scale: 2, priceMinor: 250000n })],
    ...over,
  };
}

export function row(over: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: SERVICE_ID,
    name: "web-app",
    region: "ap-southeast-1",
    state: "active",
    publicUrl: PUBLIC_URL,
    ...over,
  };
}

export function detail(over: Partial<ContainerDetail> = {}): ContainerDetail {
  return {
    ...row(),
    power: "micro",
    scale: 2,
    deployment: {
      containers: [
        {
          image: "nginx:1.27",
          ports: [{ port: 80, protocol: "HTTP" }],
          variables: ["MODE", "API_TOKEN"],
        },
      ],
      publicEndpoint: { port: 80, healthCheckPath: "/health" },
    },
    runs: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000a9",
        state: "succeeded",
        needsApproval: false,
        createdAt: new Date("2026-11-11T08:00:00Z"),
      },
    ],
    createdAt: new Date("2026-11-10T08:00:00Z"),
    destroyOpen: true,
    endpointContainer: 1,
    currentProductId: PLAN_NANO,
    pendingProductId: null,
    plans: [plan(), plan({ id: PLAN_MICRO, power: "micro", scale: 2, priceMinor: 250000n })],
    renewsAt: new Date("2026-12-10T08:00:00Z"),
    certificate: null,
    history: [{ at: new Date("2026-11-11T08:00:00Z"), images: ["nginx:1.27"], endpoint: true }],
    ...over,
  };
}

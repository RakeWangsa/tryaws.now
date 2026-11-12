import type {
  LoadBalancerConfiguratorScreen,
  LoadBalancerDetail,
  LoadBalancerPlanOption,
  LoadBalancerRow,
  TargetServer,
} from "../../../../server/load-balancers-view.ts";

// Rows for the render tests of the load balancer screens (never imported by a page).

export const LB_ID = "0190aaaa-0000-7000-8000-0000000000e1";
export const SERVER_1 = "0190aaaa-0000-7000-8000-0000000000a1";
export const SERVER_2 = "0190aaaa-0000-7000-8000-0000000000a2";
export const SERVER_FAR = "0190aaaa-0000-7000-8000-0000000000a3";
export const PLAN = "0190aaaa-0000-7000-8000-0000000000b1";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";

export const noopAction = async () => ({});

export function plan(over: Partial<LoadBalancerPlanOption> = {}): LoadBalancerPlanOption {
  return { id: PLAN, region: "ap-southeast-1", priceMinor: 180000n, ...over };
}

export function server(over: Partial<TargetServer> = {}): TargetServer {
  return { id: SERVER_1, name: "web-1", region: "ap-southeast-1", ...over };
}

export function configurator(
  over: Partial<Extract<LoadBalancerConfiguratorScreen, { state: "ready" }>> = {},
): LoadBalancerConfiguratorScreen {
  return {
    state: "ready",
    plans: [plan(), plan({ id: "0190aaaa-0000-7000-8000-0000000000b2", region: "ap-south-1" })],
    servers: [
      server(),
      server({ id: SERVER_2, name: "web-2" }),
      server({ id: SERVER_FAR, name: "mumbai-1", region: "ap-south-1" }),
    ],
    ...over,
  };
}

export function row(over: Partial<LoadBalancerRow> = {}): LoadBalancerRow {
  return {
    id: LB_ID,
    name: "front",
    region: "ap-southeast-1",
    state: "active",
    targetCount: 2,
    ...over,
  };
}

export function detail(over: Partial<LoadBalancerDetail> = {}): LoadBalancerDetail {
  return {
    ...row(),
    createdAt: new Date("2026-11-10T08:00:00Z"),
    targets: [
      { id: SERVER_1, name: "web-1", state: "active" },
      { id: "0190aaaa-0000-7000-8000-0000000000a9", name: "", state: null },
    ],
    candidates: [{ id: SERVER_2, name: "web-2" }],
    ...over,
  };
}

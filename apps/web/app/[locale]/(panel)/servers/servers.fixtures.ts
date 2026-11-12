import type { SshKey } from "@tc/db";
import type {
  ConfiguratorScreen,
  OrderScreen,
  PlanOption,
  ServerDetail,
  ServerRow,
} from "../../../../server/servers-view.ts";
import type { ReviewScreen } from "../../../../server/review-view.ts";
import type { ServerManage } from "../../../../server/server-manage-view.ts";

// Rows for the render tests of the server screens (never imported by a page).

export const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
export const SERVER_ID = "0190aaaa-0000-7000-8000-0000000000a1";
export const PRODUCT_A = "0190aaaa-0000-7000-8000-0000000000b1";
export const PRODUCT_B = "0190aaaa-0000-7000-8000-0000000000b2";
export const KEY_ID = "0190aaaa-0000-7000-8000-0000000000c1";
export const ORDER_ID = "0190aaaa-0000-7000-8000-0000000000d1";

export const noopAction = async () => ({});

export function plan(over: Partial<PlanOption> = {}): PlanOption {
  return {
    id: PRODUCT_A,
    region: "ap-south-1",
    priceMinor: 69000n,
    specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2048 },
    ...over,
  };
}

export function configurator(
  over: Partial<Extract<ConfiguratorScreen, { state: "ready" }>> = {},
): ConfiguratorScreen {
  return {
    state: "ready",
    plans: [
      plan(),
      plan({
        id: PRODUCT_B,
        priceMinor: 138000n,
        specs: { vcpus: 4, ramGb: "4", diskGb: 80, transferGb: 4096 },
      }),
      plan({
        id: "0190aaaa-0000-7000-8000-0000000000b3",
        region: "ap-southeast-1",
        priceMinor: 72000n,
      }),
    ],
    regions: ["ap-south-1", "ap-southeast-1"],
    keys: [{ id: KEY_ID, name: "Laptop", fingerprint: "SHA256:abc" }],
    images: {
      "ap-south-1": [
        {
          id: "ubuntu_24_04",
          name: "Ubuntu",
          kind: "os",
          version: "24.04 LTS",
          loginUser: "ubuntu",
          logo: "ubuntu",
        },
        {
          id: "amazon_linux_2023",
          name: "Amazon Linux",
          kind: "os",
          version: "2023",
          loginUser: "ec2-user",
          logo: null,
        },
        {
          id: "wordpress",
          name: "WordPress",
          kind: "app",
          version: null,
          loginUser: "bitnami",
          logo: "wordpress",
        },
      ],
      "ap-southeast-1": [],
    },
    ...over,
  };
}

export function server(over: Partial<ServerRow> = {}): ServerRow {
  return {
    id: SERVER_ID,
    name: "web-1",
    region: "ap-south-1",
    state: "active",
    publicIp: "203.0.113.10",
    specs: { vcpus: 2, ramGb: "1", diskGb: 40, transferGb: 2048 },
    ...over,
  };
}

export function detail(over: Partial<ServerDetail> = {}): ServerDetail {
  return {
    ...server(),
    family: "linux_instance",
    keyName: "Laptop",
    imageName: "Ubuntu",
    loginUser: "ubuntu",
    createdAt: new Date("2026-11-10T06:00:00Z"),
    ...over,
  };
}

export function manage(over: Partial<ServerManage> = {}): ServerManage {
  return {
    flagOn: true,
    requestId: "0190aaaa-0000-7000-8000-0000000000f1",
    state: "active",
    rules: [{ protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] }],
    sshOpenToWorld: true,
    staticIpAttached: true,
    staticIpFee: { hourMinor: "74", charging: false },
    loginUser: "ubuntu",
    busy: false,
    ...over,
  };
}

export function review(
  over: Partial<Extract<ReviewScreen, { state: "ready" }>> = {},
): ReviewScreen {
  return {
    state: "ready",
    token: "payload.mac",
    name: "web-1",
    region: "ap-south-1",
    productId: PRODUCT_A,
    expiresAt: new Date("2026-11-12T01:00:00Z"),
    baseMinor: 60000n,
    steps: [{ code: "bd_vat", amountMinor: 9000n }],
    totalMinor: 69000n,
    balanceMinor: 150000n,
    balanceAfterMinor: 81000n,
    shortfallTaka: null,
    ...over,
  };
}

export function order(over: Partial<OrderScreen> = {}): OrderScreen {
  return {
    id: ORDER_ID,
    totalMinor: 69000n,
    createdAt: new Date("2026-11-12T00:00:00Z"),
    progress: "creating",
    resourceId: SERVER_ID,
    serverName: "web-1",
    ...over,
  };
}

export function key(over: Partial<SshKey> = {}): SshKey {
  return {
    id: KEY_ID,
    name: "Laptop",
    publicKey: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:abcdefghijklmnop",
    createdAt: new Date("2026-11-10T06:00:00Z"),
    ...over,
  };
}

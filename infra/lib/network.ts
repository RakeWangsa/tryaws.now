// CIDR and AZ table (3.3: two AZs, public and private subnets, managed NAT; invoice-renderer in two
// isolated subnets). Pure data and checks. Each stage kind has its own /16 so a later peering or
// transit link never meets overlapping ranges.
import { REGION, type StageKind } from "./stage";

export const AZ_COUNT = 2;
export const AVAILABILITY_ZONES = [`${REGION}a`, `${REGION}b`] as const;

export const VPC_CIDR: Readonly<Record<StageKind, string>> = {
  production: "10.20.0.0/16",
  staging: "10.10.0.0/16",
  personal: "10.30.0.0/16",
};

export interface SubnetPlan {
  readonly az: string;
  readonly cidr: string;
}

// SST's Vpc component lays out its own public and private subnets from the low third octets
// (VERIFY, infra/stacks/network.ts). The isolated subnets are raw aws.ec2.Subnet resources placed in
// the high octets so the two layouts cannot meet.
export function isolatedSubnets(kind: StageKind): readonly SubnetPlan[] {
  const prefix = VPC_CIDR[kind].split(".").slice(0, 2).join(".");
  return AVAILABILITY_ZONES.map((az, index) => ({ az, cidr: `${prefix}.${200 + index}.0/24` }));
}

function toRange(cidr: string): readonly [number, number] {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
  if (match === null) throw new Error("not an IPv4 CIDR");
  const octets = match.slice(1, 5).map(Number);
  const bits = Number(match[5]);
  if (octets.some((o) => o > 255) || bits > 32) throw new Error("not an IPv4 CIDR");
  const [a = 0, b = 0, c = 0, d = 0] = octets;
  const base = ((a * 256 + b) * 256 + c) * 256 + d;
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  return [start, start + size - 1];
}

export function cidrsOverlap(x: string, y: string): boolean {
  const [xs, xe] = toRange(x);
  const [ys, ye] = toRange(y);
  return xs <= ye && ys <= xe;
}

export function cidrContains(outer: string, inner: string): boolean {
  const [os, oe] = toRange(outer);
  const [is, ie] = toRange(inner);
  return os <= is && ie <= oe;
}

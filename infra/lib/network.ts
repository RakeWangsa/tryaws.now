// CIDR and AZ table (3.3: two AZs, public and private subnets, NAT; invoice-renderer in two
// isolated subnets). Pure data and checks. Each stage kind has its own /16 so a later peering or
// transit link never meets overlapping ranges.
import { InfraConfigError, REGION, type StageKind } from "./stage";

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

const prefixOf = (kind: StageKind) => VPC_CIDR[kind].split(".").slice(0, 2).join(".");

// SST's Vpc component lays out its own public and private subnets in the low third octets, rebased onto
// the stage's /16 by rebaseSubnetCidr below (infra/stacks/network.ts). The isolated subnets are raw
// aws.ec2.Subnet resources placed in the high octets (200 and 201) so the two layouts cannot meet.
export function isolatedSubnets(kind: StageKind): readonly SubnetPlan[] {
  const prefix = prefixOf(kind);
  return AVAILABILITY_ZONES.map((az, index) => ({ az, cidr: `${prefix}.${200 + index}.0/24` }));
}

// WPU-Z10, VERIFY review 2026-11-13 (docs/analysis/verify-review-2026-11-13.md, B1
// infra/stacks/network.ts:25, lines 144 to 154): SST 4.17.2 vpc.ts hard-codes its subnets as
// 10.0.(8 x i).0/22 (public) and 10.0.(8 x i + 4).0/22 (private) whatever the VPC CIDR, so with the
// stage's /16 of VPC_CIDR they would lie outside the VPC and the deploy would fail. This moves such a
// CIDR onto the stage's /16 (10.10.0.0/22, 10.10.4.0/22, 10.10.8.0/22 and 10.10.12.0/22 on staging),
// clear of the isolated .200 and .201 subnets. Fail closed (R16): a CIDR outside SST's layout (a later
// SST version that changed it) stops the deploy instead of producing an overlapping subnet.
const SST_SUBNET = /^10\.0\.(\d{1,3})\.0\/22$/;

export function rebaseSubnetCidr(cidr: string, kind: StageKind): string {
  const match = SST_SUBNET.exec(cidr);
  const third = match === null ? NaN : Number(match[1]);
  if (!(third >= 0 && third <= 252 && third % 4 === 0)) {
    throw new InfraConfigError(`subnet ${cidr} is not in the layout of SST 4.17.2 (10.0.x.0/22)`);
  }
  const rebased = `${prefixOf(kind)}.${third}.0/22`;
  const clash = isolatedSubnets(kind).some((plan) => cidrsOverlap(plan.cidr, rebased));
  if (!cidrContains(VPC_CIDR[kind], rebased) || clash) {
    throw new InfraConfigError(`subnet ${rebased} does not fit the VPC of a ${kind} stage`);
  }
  return rebased;
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

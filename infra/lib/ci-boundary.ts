// WPU-Z11: what the CI deploy roles require of every IAM resource SST creates (pure, no SST global, so
// tsc and vitest check it: tests/repo/golive.test.mjs). infra/app.ts applies it with $transform.
//
// infra/org/ci-deploy-<stage>.yaml lets its role create or change a role only when the role carries the
// permissions boundary of that stage (iam:PermissionsBoundary condition), and only under the names
// tc-<stage>-* and tryaws-now-<stage>-*. The two stages may share one account (owner decision
// 2026-11-13), so each stage has its own boundary policy name. A personal stage is deployed by a person
// with administrator credentials and gets no boundary (the policies exist only where ci-roles.sh ran).

import { stageKind } from "./stage";

const ACCOUNT_ID = /^[0-9]{12}$/;

export const CI_ROLE_BOUNDARY = {
  staging: "TcCiRoleBoundaryStaging",
  production: "TcCiRoleBoundaryProduction",
} as const;

// The boundary ARN for a role of the stage, or null for a personal stage. Throws on a malformed account
// id (fail closed, R16: a wrong ARN would let CreateRole fail late, in the middle of a deploy).
export function ciRoleBoundaryArn(stage: string, accountId: string): string | null {
  const kind = stageKind(stage);
  if (kind === "personal") return null;
  if (!ACCOUNT_ID.test(accountId)) throw new Error("account id must be 12 digits");
  return `arn:aws:iam::${accountId}:policy/${CI_ROLE_BOUNDARY[kind]}`;
}

// SST leaves aws.iam.InstanceProfile unnamed (component.ts lists it as "not prefixed"), so Pulumi names
// the NAT instance profile of a lean stage `VpcNatInstanceProfile-<random>`, which no CI deploy policy
// allows. This gives it tc-<stage>-<logical name>, inside the instance-profile/tc-<stage>-* that the CI
// policy of the stage allows. IAM instance profile names: at most 128 of [A-Za-z0-9+=,.@_-].
export function instanceProfileName(stage: string, logicalName: string): string {
  stageKind(stage);
  const part = logicalName.replace(/[^A-Za-z0-9+=,.@_-]/g, "-");
  if (part.length === 0) throw new Error("instance profile logical name is empty");
  return `tc-${stage}-${part}`.slice(0, 128);
}

import type { CaseSet } from "./define";
import { profileCases } from "./profile";
import { auditCases } from "./audit";
import { sshKeysCases } from "./ssh-keys";
import { resourcesCases } from "./resources";
import { operationsCases } from "./operations";

// Every repository of customerRepos has one case module in this folder. To add a repository: create
// <repo>.ts with defineCaseSet and add one import line and one entry here. Do not edit
// cross-tenant.test.ts.
// Keep the entries one per line: the next line stops Prettier from joining a short array into one
// line, so that adding a repository adds one line and changes no other.
// prettier-ignore
export const CASE_SETS: readonly CaseSet[] = [
  profileCases,
  auditCases,
  sshKeysCases,
  resourcesCases,
  operationsCases,
];

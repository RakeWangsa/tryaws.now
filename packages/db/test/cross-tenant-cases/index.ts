import type { CaseSet } from "./define";
import { profileCases } from "./profile";
import { auditCases } from "./audit";
import { sshKeysCases } from "./ssh-keys";
import { resourcesCases } from "./resources";
import { operationsCases } from "./operations";
import { homesCases } from "./homes";
import { waitlistCases } from "./waitlist";
import { rateLimitsCases } from "./rate-limits";
import { otpCases } from "./otp";
<<<<<<< HEAD
import { paymentsCases } from "./payments";
=======
import { ordersCases } from "./orders";
>>>>>>> 6a60ec4 (WP4-T4: the orders repository of a customer, with its cross-tenant cases)

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
  homesCases,
  waitlistCases,
  rateLimitsCases,
  otpCases,
<<<<<<< HEAD
  paymentsCases,
=======
  ordersCases,
>>>>>>> 6a60ec4 (WP4-T4: the orders repository of a customer, with its cross-tenant cases)
];

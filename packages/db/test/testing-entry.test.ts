import { expect, it } from "vitest";
import * as testing from "../testing/index";

it("the testing entry re-exports the harness and the fixtures of WP1-T1", () => {
  for (const name of [
    "useTempDatabase",
    "createTempDatabase",
    "insertRow",
    "inTransaction",
    "uniqueSuffix",
    "ensureMarket",
    "newAdmin",
    "newCustomer",
    "newResource",
  ]) {
    expect(typeof (testing as Record<string, unknown>)[name], name).toBe("function");
  }
});

// Every name a test of another package imports from @tc/db/testing. Types are erased and are not
// listed. A later task may add exports: this is a floor, not an exact list.
it("the testing entry exports every helper of WP1-T2 that exists so far", () => {
  expect(Object.keys(testing)).toEqual(
    expect.arrayContaining([
      // WP1-T1: the harness and the fixtures
      "useTempDatabase",
      "createTempDatabase",
      "insertRow",
      "inTransaction",
      "uniqueSuffix",
      "ensureMarket",
      "newAdmin",
      "newCustomer",
      "newResource",
      // Task 3: a database bound to a role, and the transaction under a role
      "useBoundTestDatabase",
      "runTransaction",
      "bindDatabase",
      "attachErrorListeners",
      // Task 4: the ownership map and the snapshot of one customer's rows
      "tenantSnapshot",
      "TENANT_TABLES",
      "NON_TENANT_TABLES",
      // Task 5: the cross-tenant helper and the audit of recorded statements
      "checkTenantIsolation",
      "expectTenantIsolation",
      "ghostOf",
      "unscopedStatements",
      // Task 6: the repositories under a role, and the audit of ids written into SQL text
      "withCustomerRepos",
      "statementsWithInlinedIds",
    ]),
  );
});

it("the helpers of Tasks 3 to 6 are functions, and the two ownership maps are data", () => {
  for (const name of [
    "useBoundTestDatabase",
    "runTransaction",
    "bindDatabase",
    "attachErrorListeners",
    "tenantSnapshot",
    "checkTenantIsolation",
    "expectTenantIsolation",
    "ghostOf",
    "unscopedStatements",
    "withCustomerRepos",
    "statementsWithInlinedIds",
  ]) {
    expect(typeof (testing as Record<string, unknown>)[name], name).toBe("function");
  }
  expect(Object.keys(testing.TENANT_TABLES).length).toBeGreaterThan(0);
  expect(Array.isArray(testing.NON_TENANT_TABLES)).toBe(true);
});

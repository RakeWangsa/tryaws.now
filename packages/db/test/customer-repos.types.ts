import type { CustomerRepos, MethodsTakingCustomerId } from "../repositories/customer/index";

type AssertNever<T extends never> = T;
// R8: no method of a customer repository takes a customer id; the scope comes from customerRepos.
export type NoCustomerIdInputs = AssertNever<MethodsTakingCustomerId<CustomerRepos>>;
// The two checks below must fail to type-check. The directive stands on the line before the type
// argument, because that is the line Prettier leaves the error on when it wraps the alias.
export type CaughtTop = AssertNever<
  // @ts-expect-error the check finds a top-level customerId
  MethodsTakingCustomerId<{ a: { m(i: { customerId: string }): void } }>
>;
export type CaughtNested = AssertNever<
  // @ts-expect-error the check finds a nested customer_id in an array
  MethodsTakingCustomerId<{ a: { m(x: string, i: { d: { customer_id: string }[] }): void } }>
>;
export type MetadataIsFine = AssertNever<
  MethodsTakingCustomerId<{ a: { m(i: { metadata?: Record<string, unknown> }): void } }>
>;

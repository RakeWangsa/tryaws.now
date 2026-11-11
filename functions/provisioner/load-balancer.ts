import { createLoadBalancerAdapter, type ProductAdapter } from "@tc/aws";

// The adapter needs no database of its own: its targets are read through ctx.owned, which the runner
// builds from the customer id of the operation's resource (R8).
export function loadBalancerAdapter(): ProductAdapter<unknown> {
  return createLoadBalancerAdapter() as ProductAdapter<unknown>;
}

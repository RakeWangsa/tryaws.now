// Where the order screens send the customer for a product family that has its own screens: back to
// its form from the review page, and on to the new resource from the order status page. Every other
// family (the servers) keeps the default. A path is relative and fixed here (U12), never taken from a
// request.

const CONFIGURE: Readonly<Record<string, string>> = Object.freeze({
  cdn: "/cdn/new",
  database: "/databases/new",
  load_balancer: "/load-balancers/new",
});

const DETAIL: Readonly<Record<string, string>> = Object.freeze({
  cdn: "/cdn",
  database: "/databases",
  load_balancer: "/load-balancers",
});

/** The form a draft came from; the server form for a family without one of its own. */
export function configurePathOf(family: string | undefined): string {
  return family !== undefined && Object.hasOwn(CONFIGURE, family)
    ? (CONFIGURE[family] as string)
    : "/servers/new";
}

/** The page of a new resource, or null when the family has none here (the order page then links to the servers). */
export function detailPathOf(family: string | undefined, resourceId: string): string | null {
  return family !== undefined && Object.hasOwn(DETAIL, family)
    ? `${DETAIL[family] as string}/${resourceId}`
    : null;
}

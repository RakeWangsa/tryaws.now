// Pure checks of the wallet screens for scripts/smoke-apps.mjs --app web (WP3-T4 Task 9). No I/O: they
// read the text of the build output and of the bundle.
import { parseRouteTable } from "./app-checks.mjs";

/** The three screens and the three return routes of EPS; Next prints the screens under [locale]. */
export const WALLET_ROUTES = Object.freeze([
  "/wallet",
  "/wallet/topup",
  "/wallet/topup/[paymentId]",
  "/pay/eps/success",
  "/pay/eps/fail",
  "/pay/eps/cancel",
]);

const matches = (found, wanted) => found === wanted || found === `/[locale]${wanted}`;

/** Every wallet route is in the table and dynamic (they read the session and the database). */
export function checkWalletRoutes(output) {
  const { routes } = parseRouteTable(output);
  if (routes.length === 0) return ["no routes parsed from the build output"];
  const problems = [];
  for (const wanted of WALLET_ROUTES) {
    const found = routes.filter((route) => matches(route.path, wanted));
    if (found.length === 0) problems.push(`route ${wanted} is missing from the route table`);
    for (const route of found) {
      if (route.kind !== "dynamic") {
        problems.push(`route ${route.path} is ${route.kind}, expected dynamic`);
      }
    }
  }
  return problems;
}

/** With TC_STAGE=production the dev sign-in and the fake checkout answer 404; responses: [{ path, status }]. */
export function checkDevRoutesRefused(responses) {
  if (responses.length === 0) return ["no dev route was asked"];
  return responses
    .filter((response) => response.status !== 404)
    .map((response) => `${response.path}: status ${response.status}, expected 404`);
}

/**
 * What only the fakes carry. The route name of the dev pages is not a marker: those routes exist in
 * every build and answer 404 unless the configuration says fakes (the check above).
 */
export const FAKE_MARKERS = Object.freeze([
  "InMemoryEps",
  // The pattern of the dev verifier in apps/web/server/fakes/dev-auth.ts.
  "^dev\\.(",
  // The checkout path that the bridge answers with.
  "/dev/eps/checkout?data=",
]);

/** files: [{ path, text }] of the code under .next/server and .next/static. A production bundle has no fake. */
export function checkNoFakeInBundle(files) {
  if (files.length === 0) return ["no bundle file was read"];
  const problems = [];
  for (const file of files) {
    for (const marker of FAKE_MARKERS) {
      if (file.text.includes(marker)) problems.push(`${file.path} contains ${marker}`);
    }
  }
  return problems;
}

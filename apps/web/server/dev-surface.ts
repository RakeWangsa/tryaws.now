import { readWebConfig } from "./config.ts";

// The dev-only surface of the Playwright proof: /dev/sign-in and the fake EPS checkout. It is on only
// when the configuration says fakes, which config.ts allows for the local and test stages in
// development or test and refuses everywhere else with an exception; an exception here means "off"
// (R16). The routes answer 404 when it is off. This file does not import the fakes (the repository
// test web-fakes allows that for runtime.ts only): it reads the object that the bridge keeps on
// globalThis after getRuntime() has built the fake runtime.

export function devSurfaceEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  try {
    return readWebConfig(env).fakes;
  } catch {
    return false;
  }
}

/** What the fake checkout needs of the bridge: settle a payment, and find a payment by the `data` of the URL. */
export interface DevEpsHandle {
  fake: { settle(merchantTransactionId: string, outcome: { status: string }): void };
  byData: Map<string, string>;
}

export function devEps(): DevEpsHandle | null {
  const held = (globalThis as unknown as Record<string, DevEpsHandle | undefined>)["__tcDevEps"];
  return held ?? null;
}

const DATA = /^[0-9]{1,12}$/;
export const isDevData = (value: unknown): value is string =>
  typeof value === "string" && DATA.test(value);

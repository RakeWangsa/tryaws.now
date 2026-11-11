import type { ComponentType, ReactNode } from "react";

/** The two locales of the product. Bengali is written first (U5). */
export type Locale = "bn" | "en";

/** Which digits money, dates and counts use: Bengali (beng) or Latin (latn). */
export type Numerals = "beng" | "latn";

/**
 * A link component the caller passes as `as`. The kit never imports `next/link`; a plain `<a>` is
 * the default.
 */
export type LinkComponent = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-disabled"?: boolean;
  tabIndex?: number;
}>;

/** Narrows a string to a Locale. Anything else is a defect of the caller (R16: fail closed). */
export function toLocale(value: string): Locale {
  if (value === "bn" || value === "en") return value;
  throw new RangeError(`unknown locale ${JSON.stringify(value)}; expected "bn" or "en"`);
}

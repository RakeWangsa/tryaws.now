import { useLocale } from "next-intl";
import { formatMoney } from "./format";
import { toLocale, type Numerals } from "./types";

export interface MoneyTextProps {
  /** Paisa. A number throws TypeError (R4). */
  minor: bigint;
  /** `wholeUp` rounds up to whole taka (plan cards, price tables). */
  mode?: "exact" | "wholeUp";
  /** Overrides the digits of the locale (the market setting). */
  numerals?: Numerals;
  className?: string;
}

/** The only place that formats money (16.13). */
export function MoneyText({ minor, mode, numerals, className }: MoneyTextProps) {
  const locale = toLocale(useLocale());
  return <span className={className}>{formatMoney(minor, { locale, mode, numerals })}</span>;
}

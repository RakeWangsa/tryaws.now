import { useLocale } from "next-intl";
import { formatUsd } from "./format";
import { toLocale, type Numerals } from "./types";

export interface UsdTextProps {
  /** Plain decimal text of dollars from the pricing engine (customerUsd), never a number (R4). */
  text: string;
  numerals?: Numerals;
  className?: string;
}

/** The only place that formats a public price in US dollars (WPU-Y4). */
export function UsdText({ text, numerals, className }: UsdTextProps) {
  const locale = toLocale(useLocale());
  return <span className={className}>{formatUsd(text, { locale, numerals })}</span>;
}

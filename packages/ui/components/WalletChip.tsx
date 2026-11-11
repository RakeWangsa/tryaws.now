import { useTranslations } from "next-intl";
import { Button } from "./Button";
import { MoneyText } from "./MoneyText";
import type { LinkComponent } from "./types";

export interface WalletChipProps {
  /** Paisa. A number throws TypeError (R4). */
  balanceMinor: bigint;
  topUpHref: string;
  linkAs?: LinkComponent;
}

/** The wallet balance and the yellow top-up button of the header (header.html, "CLIENT AREA"). */
export function WalletChip({ balanceMinor, topUpHref, linkAs }: WalletChipProps) {
  const t = useTranslations("kit.wallet");
  if (typeof balanceMinor !== "bigint") {
    throw new TypeError("WalletChip: balanceMinor must be a bigint of paisa");
  }
  return (
    <div className="tc-wallet-chip d-flex align-items-center gap-2">
      <span className="mergecolor">
        <span className="visually-hidden">{t("balance")}</span>
        <MoneyText minor={balanceMinor} mode="exact" />
      </span>
      <Button variant="primary" size="sm" href={topUpHref} as={linkAs}>
        {t("topUp")}
      </Button>
    </div>
  );
}

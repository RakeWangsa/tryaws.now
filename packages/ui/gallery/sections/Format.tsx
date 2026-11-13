import { useLocale, useTranslations } from "next-intl";
import type { ReactElement } from "react";
import { DateText } from "../../components/DateText.tsx";
import { LocaleSwitch } from "../../components/LocaleSwitch.tsx";
import { MoneyText } from "../../components/MoneyText.tsx";
import { toLocale } from "../../components/types.ts";
import { UsdText } from "../../components/UsdText.tsx";
import { WalletChip } from "../../components/WalletChip.tsx";
import { localeHrefs, localePath } from "../../runtime/index.ts";
import { DEMO_BALANCE_MINOR, DEMO_INSTANT, MONEY_SAMPLES } from "../data.ts";
import { Sample } from "../Sample.tsx";

export function Format(): ReactElement {
  const t = useTranslations("Gallery.demo.format");
  const locale = toLocale(useLocale());
  const hrefs = localeHrefs("/dev/ui");
  return (
    <>
      <Sample name="MoneyText" titleKey="Gallery.samples.moneyText">
        <div className="table-responsive-sm">
          <table className="table compare min">
            <thead>
              <tr className="seccolor">
                <th scope="col">{t("exact")}</th>
                <th scope="col">{t("whole")}</th>
                <th scope="col">{t("latin")}</th>
              </tr>
            </thead>
            <tbody>
              {MONEY_SAMPLES.map((minor) => (
                <tr key={minor.toString()} className="seccolor">
                  <td>
                    <MoneyText minor={minor} mode="exact" />
                  </td>
                  <td>
                    <MoneyText minor={minor} mode="wholeUp" />
                  </td>
                  <td>
                    <MoneyText minor={minor} mode="exact" numerals="latn" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Sample>
      <Sample name="UsdText" titleKey="Gallery.samples.usdText">
        <ul className="list-unstyled seccolor">
          {["0.00", "5.85", "14.0400", "0.585"].map((text) => (
            <li key={text}>
              <UsdText text={text} />
            </li>
          ))}
        </ul>
      </Sample>
      <Sample name="DateText" titleKey="Gallery.samples.dateText">
        <ul className="list-unstyled seccolor">
          <li>
            {t("dateOnly")}: <DateText value={DEMO_INSTANT} variant="date" />
          </li>
          <li>
            {t("dateTime")}: <DateText value={DEMO_INSTANT} variant="datetime" />
          </li>
          <li>
            {t("timeOnly")}: <DateText value={DEMO_INSTANT} variant="time" />
          </li>
        </ul>
      </Sample>
      <Sample name="LocaleSwitch" titleKey="Gallery.samples.localeSwitch">
        <div className="tc-lang-static">
          <LocaleSwitch
            current={locale}
            items={[
              { locale: "bn", href: hrefs.bn },
              { locale: "en", href: hrefs.en },
            ]}
          />
        </div>
      </Sample>
      <Sample name="WalletChip" titleKey="Gallery.samples.walletChip">
        <WalletChip balanceMinor={DEMO_BALANCE_MINOR} topUpHref={localePath(locale, "/wallet")} />
      </Sample>
    </>
  );
}

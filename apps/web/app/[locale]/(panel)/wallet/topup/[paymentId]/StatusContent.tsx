import type { PaymentRow } from "@tc/db";
import { Button, DateText, MoneyText, SubmitButton, formatMoney } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { publicPaymentState } from "../../../../../../server/payment-state.ts";
import type { PublicPaymentState } from "../../../../../../server/payment-state.ts";
import { PaymentWatcher } from "./PaymentWatcher.tsx";

// The content of /wallet/topup/[paymentId]: one block for each public state. Synchronous, so it
// renders in a test without a request. complete.tpl is the model of the credited state and error.tpl
// of failed, cancelled and expired; see mockup-anchors.ts. A state is an icon, a heading and words,
// never a colour alone (U11).

type Numerals = "beng" | "latn";

const LOOK: Record<PublicPaymentState, { icon: string; alert: string | null }> = {
  credited: { icon: "fas fa-check-circle", alert: null },
  pending: { icon: "fas fa-hourglass-half", alert: null },
  failed: { icon: "fas fa-exclamation-triangle", alert: "alert alert-danger" },
  cancelled: { icon: "fas fa-exclamation-triangle", alert: "alert alert-danger" },
  expired: { icon: "fas fa-exclamation-triangle", alert: "alert alert-danger" },
};

/** The reference a customer can quote to support: the first 8 characters of the payment id, never the gateway's id. */
export function referenceOf(payment: Pick<PaymentRow, "id">): string {
  return payment.id.slice(0, 8);
}

export function StatusContent({
  locale,
  numerals,
  payment,
  balanceMinor,
  checkAgain,
}: {
  locale: Locale;
  numerals: Numerals;
  payment: PaymentRow;
  /** The live wallet balance of the customer (R6). */
  balanceMinor: bigint;
  /** The no-JS "Check again" form: a Server Action bound to this payment. */
  checkAgain: (formData: FormData) => void | Promise<void>;
}) {
  const t = useTranslations("Wallet.status");
  const topup = useTranslations("Wallet.topup");
  const wallet = useTranslations("Wallet");
  const state = publicPaymentState(payment.status);
  const review = payment.status === "review";
  const look = LOOK[state];
  const money = (minor: bigint) => formatMoney(minor, { locale, mode: "exact", numerals });
  const walletHref = localePath(locale, "/wallet");

  const heading = (
    <>
      <i className={`${look.icon} me-2`} aria-hidden="true" />
      {t(`${state}.title`)}
    </>
  );

  const details = (
    <div className="table-responsive-sm">
      <table className="table compare min mb-4">
        <tbody>
          <tr>
            <td className="border-0 seccolor">{t("amount")}</td>
            <td className="border-0 text-end">
              <MoneyText minor={payment.amountMinor} mode="exact" numerals={numerals} />
            </td>
          </tr>
          <tr>
            <td className="border-0 seccolor">{t("date")}</td>
            <td className="border-0 text-end">
              <DateText value={payment.createdAt} numerals={numerals} />
            </td>
          </tr>
          <tr>
            <td className="border-0 seccolor">{t("reference")}</td>
            <td className="border-0 text-end">{referenceOf(payment)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <h1 className="h3 mergecolor mb-4">{topup("heading")}</h1>
      <div className="row">
        <div className="col-md-12">
          {state === "credited" ? (
            <>
              <div className="text-center mb-4">
                <h2 className="section-heading mergecolor border-0">{heading}</h2>
                <p className="section-subheading mergecolor">
                  {t("credited.body", {
                    amount: money(payment.amountMinor),
                    balance: money(balanceMinor),
                  })}
                </p>
              </div>
              <div className="bg-seccolorstyle sec-bg1 p-3 p-md-5 br-12 noshadow">
                {details}
                <div className="text-center">
                  <Button variant="primary" href={walletHref}>
                    {t("backToWallet")}
                  </Button>{" "}
                  <Button variant="default" href={localePath(locale, "/servers/new")}>
                    {t("createServer")}
                  </Button>
                </div>
              </div>
            </>
          ) : state === "pending" ? (
            <div className="bg-seccolorstyle sec-bg1 p-3 p-md-5 br-12 noshadow text-center">
              <h2 className="section-heading mergecolor border-0">{heading}</h2>
              <p className="section-subheading mergecolor">{t("pending.body")}</p>
              {review ? (
                <p className="seccolor" role="status">
                  {t("review")}
                </p>
              ) : (
                <PaymentWatcher paymentId={payment.id} />
              )}
              <div className="text-start">{details}</div>
              <form action={checkAgain}>
                <SubmitButton variant="default" icon="fas fa-sync-alt">
                  {t("checkAgain")}
                </SubmitButton>
              </form>
            </div>
          ) : (
            <>
              <div className="text-center mb-4">
                <h2 className="section-heading mergecolor border-0">{t(`${state}.title`)}</h2>
                <p className="section-subheading mergecolor">{t(`${state}.body`)}</p>
              </div>
              <div className="bg-seccolorstyle sec-bg1 p-3 p-md-5 br-12 noshadow">
                <div className={look.alert ?? "alert"} role="alert">
                  <i className={`${look.icon} me-2`} aria-hidden="true" />
                  {wallet(`state.${state}`)}
                </div>
                {details}
                <div className="text-center">
                  <Button variant="primary" href={localePath(locale, "/wallet/topup")}>
                    {t("tryAgain")}
                  </Button>{" "}
                  <Button variant="default" href={walletHref}>
                    {t("backToWallet")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

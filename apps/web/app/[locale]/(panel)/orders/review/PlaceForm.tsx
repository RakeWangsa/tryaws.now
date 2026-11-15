"use client";

import {
  Button,
  MoneyText,
  PriceBreakdown,
  SubmitButton,
  SummarySidebar,
  formatMoney,
} from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { useActionState, useId, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import { topUpHref } from "../../../../../server/topup-link.ts";
import type { ReviewScreen } from "../../../../../server/review-view.ts";
import { useRegionLabel } from "../../servers/ServerParts.tsx";

// The review of an order (16.11 steps 3 to 5; cart.html: table.table.compare and the order summary).
// Client Component: it holds the checkbox of the terms and the answer of the action. Every price here
// came from the signed draft or from placeOrder; the text of a total is formatted, never computed.

type Ready = Extract<ReviewScreen, { state: "ready" }>;

export function PlaceForm({
  locale,
  review,
  autoRenew,
  idempotencyKey,
  configureHref,
  action,
}: {
  locale: Locale;
  review: Ready;
  /**
   * WPU-Z2: the purchase of this family turns auto-renew on (`autoRenewAtPurchase` of @tc/core, read by
   * ReviewContent on the server). Only then is the auto-renew line shown.
   */
  autoRenew: boolean;
  /** One key for each view of the page: a double click sends the same key twice (R7). */
  idempotencyKey: string;
  configureHref: string;
  action: (previous: FormState, form: FormData) => Promise<FormState>;
}) {
  const t = useTranslations("Orders.review");
  const tf = useTranslations("Flow");
  const regionLabel = useRegionLabel();
  const base = useId();
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const [accepted, setAccepted] = useState(false);

  // price_changed: the old and the new total are shown and the new token is the one that is posted.
  const changed = state.draft;
  const token = changed?.token ?? review.token;
  const totalMinor = changed !== undefined ? BigInt(changed.totalMinor) : review.totalMinor;
  // What the customer sees is exactly what is charged: the BDT amount of the signed draft (or of the new one
  // after a change). Nothing is computed here. WPU-X16: no dollar price and no exchange rate is printed.
  const shortfallMinor = totalMinor > review.balanceMinor ? totalMinor - review.balanceMinor : null;
  const shortfallTaka = shortfallMinor === null ? null : (shortfallMinor + 99n) / 100n;
  const errorKey =
    state.error !== undefined && state.error !== "price_changed" ? state.error : null;

  const sidebarRows = [
    { label: t("balance"), value: <MoneyText minor={review.balanceMinor} /> },
    shortfallMinor === null
      ? {
          label: t("balanceAfter"),
          value: <MoneyText minor={review.balanceMinor - totalMinor} />,
        }
      : { label: t("shortfall"), value: <MoneyText minor={shortfallMinor} /> },
    { label: t("total"), value: <MoneyText minor={totalMinor} />, strong: true },
  ];

  return (
    <form action={formAction} noValidate>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      {changed !== undefined ? (
        <div className="alert alert-warning text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          <b>{t("priceChanged.title")}</b> {t("priceChanged.body")}{" "}
          <span className="d-block">
            {t("priceChanged.old")}: <MoneyText minor={review.totalMinor} /> ·{" "}
            {t("priceChanged.new")}: <MoneyText minor={totalMinor} />
          </span>
        </div>
      ) : null}
      {errorKey !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {tf.has(`error.${errorKey}`) ? tf(`error.${errorKey}`) : tf("error.unavailable")}
        </div>
      ) : null}

      <div className="row">
        <div className="col-lg-8">
          <div className="table-responsive-lg mb-4">
            <table className="table compare">
              <caption className="visually-hidden">{t("caption")}</caption>
              <tbody>
                <tr className="seccolor">
                  <th scope="row" className="title border-start-0">
                    {t("item")}
                  </th>
                  <td>{t("itemValue", { name: review.name })}</td>
                </tr>
                <tr className="seccolor">
                  <th scope="row" className="title border-start-0">
                    {t("location")}
                  </th>
                  <td>{regionLabel(review.region)}</td>
                </tr>
                <tr className="seccolor">
                  <th scope="row" className="title border-start-0">
                    {t("term")}
                  </th>
                  <td>{t("termValue")}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="table-responsive-lg mb-4">
            <table className="table compare">
              <caption className="visually-hidden">{t("debit.caption")}</caption>
              <tbody>
                <tr className="seccolor">
                  <th scope="row" className="title border-start-0">
                    {t("debit.bdt")}
                  </th>
                  <td>
                    <b>
                      <MoneyText minor={totalMinor} />
                    </b>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="small seccolor mt-2">{t("debit.note")}</p>
          </div>

          {changed === undefined ? (
            <div className="mb-4">
              <h2 className="mergecolor h4 mb-3">{t("lines")}</h2>
              <PriceBreakdown
                baseMinor={review.baseMinor}
                steps={review.steps.map((step) => ({
                  code: step.code,
                  label: t.has(`step.${step.code}`) ? t(`step.${step.code}`) : step.code,
                  amountMinor: step.amountMinor,
                }))}
                totalMinor={review.totalMinor}
              />
            </div>
          ) : null}

          {/* WPU-Z2, WPU-Z14: the customer reads it before confirming, only for a family that a purchase
              opens with auto-renew on: the line points to the switch on the page of the service, which
              every such family has. */}
          {autoRenew ? <p className="seccolor">{t("autoRenew")}</p> : null}
          <p className="seccolor">{t("renewal")}</p>

          {shortfallTaka !== null ? (
            <div className="alert alert-warning text-start" role="status">
              <i className="fas fa-wallet me-2" aria-hidden="true" />
              {t("shortfallBody", {
                amount: formatMoney(shortfallTaka * 100n, { locale, mode: "wholeUp" }),
              })}
              <div className="mt-3">
                <Button variant="primary" href={topUpHref(locale, shortfallTaka, token)}>
                  {t("topUp")}
                </Button>
              </div>
            </div>
          ) : null}

          <div className="cd-filter-content mb-4">
            <input
              type="checkbox"
              id={`${base}-terms`}
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <label className="checkbox-label seccolor" htmlFor={`${base}-terms`}>
              {t("terms")}
            </label>
          </div>
          <p className="mb-4">
            <a href={configureHref}>{t("back")}</a>
          </p>
        </div>

        <div className="col-lg-4">
          <SummarySidebar
            title={t("confirmSummary")}
            rows={sidebarRows}
            action={
              <SubmitButton
                variant="primary"
                className="w-100"
                disabled={!accepted || shortfallTaka !== null}
              >
                {t("confirm")}
              </SubmitButton>
            }
          />
        </div>
      </div>
    </form>
  );
}

"use client";

import { Field, MoneyText, OptionGroup, SubmitButton, formatMoney } from "@tc/ui";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import type { ChangeEvent } from "react";
import { startTopUpAction } from "./actions.ts";
import { previewAmount } from "./amount-preview.ts";
import type { PreviewRange as TopUpRange } from "./amount-preview.ts";
import type { TopUpFormState } from "../../../../../server/topup-core.ts";

// The form of /wallet/topup. It owns the typed text, mirrors a chosen quick amount into the field,
// shows the amount the server will read, and posts to the Server Action (U8). The action checks
// everything again: nothing here is trusted.

type Numerals = "beng" | "latn";

const WHOLE_MINOR = /^[0-9]{1,12}$/;

/** The text of the field for a quick amount given in paisa (always whole taka). */
export function quickText(minor: string): string | null {
  if (!WHOLE_MINOR.test(minor)) return null;
  return (BigInt(minor) / 100n).toString();
}

export function TopUpForm({
  locale,
  numerals,
  range,
  quick,
  initialKey,
}: {
  locale: Locale;
  numerals: Numerals;
  range: TopUpRange;
  quick: bigint[];
  initialKey: string;
}) {
  const [state, formAction] = useActionState<TopUpFormState, FormData>(startTopUpAction, {
    status: "idle",
    idempotencyKey: initialKey,
  });
  const [text, setText] = useState("");

  // Event delegation: one handler on the form sees the radios of the quick amounts.
  const onFormChange = (event: ChangeEvent<HTMLFormElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.name === "quick" && target.checked) {
      const next = quickText(target.value);
      if (next !== null) setText(next);
    }
  };

  return (
    <TopUpFormView
      locale={locale}
      numerals={numerals}
      range={range}
      quick={quick}
      state={state}
      text={text}
      onText={setText}
      onFormChange={onFormChange}
      formAction={formAction}
    />
  );
}

/** The markup of the form for a given state: no hooks of its own, so a test can render every state. */
export function TopUpFormView({
  locale,
  numerals,
  range,
  quick,
  state,
  text,
  onText,
  onFormChange,
  formAction,
}: {
  locale: Locale;
  numerals: Numerals;
  range: TopUpRange;
  quick: bigint[];
  state: TopUpFormState;
  text: string;
  onText: (text: string) => void;
  onFormChange: (event: ChangeEvent<HTMLFormElement>) => void;
  formAction: (formData: FormData) => void;
}) {
  const t = useTranslations("Wallet.topup");
  const money = (minor: bigint) => formatMoney(minor, { locale, mode: "exact", numerals });
  const bounds = { min: money(range.minMinor), max: money(range.maxMinor) };
  const previewMinor = previewAmount(text, range);
  const fieldError =
    state.status === "error" && state.field !== undefined ? state.field.amount : null;

  const code = state.status === "error" ? (state.code ?? null) : null;
  const requestId = state.status === "error" ? state.requestId : null;

  return (
    <form action={formAction} onChange={onFormChange} noValidate>
      <input type="hidden" name="idempotencyKey" value={state.idempotencyKey} />

      {code !== null ? (
        <div
          className={`alert ${code === "rate_limited" || code === "conflict" || code === "not_open" ? "alert-warning" : "alert-danger"} text-start`}
          role="alert"
        >
          <i
            className={`${code === "rate_limited" ? "fas fa-hourglass-half" : "fas fa-exclamation-triangle"} me-2`}
            aria-hidden="true"
          />
          {code === "not_open"
            ? t("closed.title")
            : code === "rate_limited"
              ? t("error.rate_limited", {
                  seconds: state.status === "error" ? (state.retryAfterSeconds ?? 60) : 60,
                })
              : t(`error.${code}`)}
          {requestId !== null && (code === "unavailable" || code === "internal") ? (
            <span className="d-block mt-2">
              {t("error.reference")}: {requestId}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="table-responsive-sm">
        <table className="table compare min mb-4">
          <tbody>
            <tr>
              <td className="border-0">
                <div className="badge bg-purple me-1">{t("total.badge")}</div>{" "}
                <span className="seccolor">{t("total.label")}</span>
              </td>
              <td className="border-0">
                <b className="float-end h4 seccolor" aria-live="polite">
                  {previewMinor !== null ? (
                    <MoneyText minor={previewMinor} mode="exact" numerals={numerals} />
                  ) : (
                    t("total.none")
                  )}
                </b>
              </td>
            </tr>
            <tr>
              <td className="border-0" colSpan={2}>
                <Field
                  name="amount"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  label={t("amount.label")}
                  hint={t("amount.hint", bounds)}
                  value={text}
                  onChange={(event) => onText(event.target.value)}
                  {...(fieldError !== null ? { error: t(`error.${fieldError}`, bounds) } : {})}
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {quick.length >= 2 ? (
        <OptionGroup
          kind="radio"
          name="quick"
          legend={t("quick.legend")}
          options={quick.map((minor) => ({ value: minor.toString(), label: money(minor) }))}
        />
      ) : null}

      <SubmitButton variant="primary" icon="fas fa-arrow-alt-circle-right">
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

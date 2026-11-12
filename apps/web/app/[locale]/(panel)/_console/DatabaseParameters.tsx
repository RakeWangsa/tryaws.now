"use client";

import { DateText, EmptyState, Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import type { DbParametersFacts } from "../../../../server/console-view.ts";
import { Choice, ConsoleNotice, Hidden } from "./ConsoleForms.tsx";
import type { ConsoleAction } from "./ConsoleForms.tsx";

// The Parameters tab of a database (WPU-G11). The list is the LAST KNOWN one: the page cannot read the
// parameter group live (the reader has no such action), so it shows what the last read or change saved,
// with its date, and a button asks for a new read. Only the safe parameters of the whitelist are shown
// (R11). A change that waits for a reboot says so, and a reboot button is there. The server checks
// everything again (R9); these forms only ask. U8: a button is inert while its action runs. U11: a
// state is a text, never a colour alone.

type Numerals = "beng" | "latn";

export function DatabaseParameters({
  saveAction,
  readAction,
  rebootAction,
  databaseId,
  saveRequestId,
  readRequestId,
  rebootRequestId,
  facts,
  numerals,
  allowed,
}: {
  saveAction: ConsoleAction;
  readAction: ConsoleAction;
  rebootAction: ConsoleAction;
  databaseId: string;
  saveRequestId: string;
  readRequestId: string;
  rebootRequestId: string;
  /** The saved list, or null if it has not been read yet. */
  facts: DbParametersFacts | null;
  numerals: Numerals;
  /** The database is active: the only state in which a parameter can change. */
  allowed: boolean;
}) {
  const t = useTranslations("Console.params");
  const tc = useTranslations("Console");
  const [saveState, saveForm] = useActionState(saveAction, INITIAL_FORM_STATE);
  const [readState, readForm] = useActionState(readAction, INITIAL_FORM_STATE);
  const [rebootState, rebootForm] = useActionState(rebootAction, INITIAL_FORM_STATE);
  const changeable = facts?.items.filter((i) => i.changeable) ?? [];
  return (
    <>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      {!allowed ? <p className="seccolor">{t("inactive")}</p> : null}

      <p className="seccolor mb-2">
        {facts?.readAt != null ? (
          <>
            <b className="mergecolor">{t("lastKnown")}</b> {t("readAt")}{" "}
            <DateText value={facts.readAt} variant="datetime" numerals={numerals} />
          </>
        ) : (
          t("notRead")
        )}
      </p>
      <form action={readForm} noValidate className="mb-3">
        <Hidden idField="databaseId" id={databaseId} requestId={readRequestId} />
        <ConsoleNotice state={readState} />
        <SubmitButton variant="default" icon="fas fa-sync" disabled={!allowed}>
          {t("read")}
        </SubmitButton>
      </form>

      {facts?.rebootPending === true ? (
        <div className="alert alert-warning text-start" role="status">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          <b className="mergecolor">{t("rebootPendingTitle")}</b> {t("rebootPending")}
        </div>
      ) : null}

      {facts === null ? (
        <EmptyState title={t("empty.title")} description={t("empty.body")} />
      ) : facts.items.length === 0 ? (
        <EmptyState title={t("none.title")} description={t("none.body")} />
      ) : (
        <form action={saveForm} noValidate className="mb-4">
          <Hidden idField="databaseId" id={databaseId} requestId={saveRequestId} />
          <ConsoleNotice state={saveState} />
          {saveState.fields?.["parameters"] !== undefined ? (
            <p className="tc-field-error" role="alert">
              {t("nothingChanged")}
            </p>
          ) : null}
          {facts.items.map((item) => {
            const applyText = item.changeable ? t(`apply.${item.apply}`) : t("notChangeable");
            const error =
              saveState.fields?.[item.name] !== undefined ? tc("field.invalid") : undefined;
            const hint = t("hint", { apply: applyText, current: item.value ?? t("valueUnknown") });
            if (!item.changeable) {
              return (
                <p key={item.name} className="mb-2">
                  <code>{item.name}</code>:{" "}
                  <b className="mergecolor">{item.value ?? t("valueUnknown")}</b>{" "}
                  <span className="seccolor">({applyText})</span>
                </p>
              );
            }
            if (item.input.kind === "int") {
              return (
                <Field
                  key={item.name}
                  name={item.name}
                  label={item.name}
                  hint={hint}
                  inputMode="numeric"
                  maxLength={12}
                  autoComplete="off"
                  optional
                  {...(item.value !== null ? { defaultValue: item.value } : {})}
                  disabled={!allowed}
                  {...(error !== undefined ? { error } : {})}
                />
              );
            }
            const options =
              item.input.kind === "bool"
                ? [
                    { value: "0", label: t("off") },
                    { value: "1", label: t("on") },
                  ]
                : item.input.values.map((v) => ({ value: v, label: v }));
            return (
              <Choice
                key={item.name}
                name={item.name}
                label={item.name}
                hint={hint}
                options={options}
                {...(item.value !== null && options.some((o) => o.value === item.value)
                  ? { defaultValue: item.value }
                  : {})}
                {...(error !== undefined ? { error } : {})}
              />
            );
          })}
          {changeable.length > 0 ? (
            <SubmitButton variant="primary" disabled={!allowed}>
              {t("save")}
            </SubmitButton>
          ) : (
            <p className="seccolor">{t("noneChangeable")}</p>
          )}
        </form>
      )}

      <form action={rebootForm} noValidate>
        <Hidden idField="databaseId" id={databaseId} requestId={rebootRequestId} />
        <h4 className="mergecolor h5">{t("reboot.title")}</h4>
        <p className="seccolor">{t("reboot.intro")}</p>
        <ConsoleNotice state={rebootState} />
        <div className="form-check mb-3">
          <input
            className="form-check-input"
            type="checkbox"
            name="acknowledge"
            value="yes"
            id="db-reboot-ack"
            disabled={!allowed}
          />
          <label className="form-check-label" htmlFor="db-reboot-ack">
            {t("reboot.acknowledge")}
          </label>
        </div>
        {rebootState.fields?.["acknowledge"] !== undefined ? (
          <p className="tc-field-error" role="alert">
            {t("reboot.acknowledgeNeeded")}
          </p>
        ) : null}
        <SubmitButton variant="default" icon="fas fa-redo" disabled={!allowed}>
          {t("reboot.submit")}
        </SubmitButton>
      </form>
    </>
  );
}

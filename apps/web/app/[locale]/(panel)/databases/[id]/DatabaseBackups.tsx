"use client";

import {
  Button,
  ConfirmDestroy,
  DataTable,
  DateText,
  EmptyState,
  Field,
  MoneyText,
  SubmitButton,
} from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { DatabaseDetail } from "../../../../../server/databases-view.ts";
import { useSpecLine } from "../../servers/ServerParts.tsx";
import { FreshSignInLink } from "../../_family/FreshSignInLink.tsx";

// The Backups tab of /databases/[id] (WPU-G9): the snapshots with their price, a new snapshot, a new
// database from a snapshot and a new database from a point in time. Every price here was computed on the
// server by the pricing engine; this file adds and rounds nothing (R4). A button is inert while its
// action runs (U8) and a result is a text, never a color alone (U11). The server checks everything again.

export type SnapshotAction = (previous: FormState, form: FormData) => Promise<FormState>;
type Numerals = "beng" | "latn";

function Notice({ state }: { state: FormState }) {
  const t = useTranslations("DbSnapshots");
  const router = useRouter();
  useEffect(() => {
    if (state.done !== undefined) router.refresh();
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t.has(`error.${state.error}`) ? t(`error.${state.error}`) : t("error.unavailable")}
        <FreshSignInLink error={state.error} />
      </div>
    );
  }
  if (state.done !== undefined) {
    const [key, flag] = state.done.split(":");
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {key !== undefined && t.has(`done.${key}`) ? t(`done.${key}`) : t("done.snapshotCreated")}
        {flag === "approval" ? ` ${t("approval")}` : ""}
      </div>
    );
  }
  return null;
}

function Hidden({ values }: { values: Record<string, string> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function CreateForm({
  action,
  databaseId,
  requestId,
  disabled,
  reason,
}: {
  action: SnapshotAction;
  databaseId: string;
  requestId: string;
  disabled: boolean;
  reason: string | null;
}) {
  const t = useTranslations("DbSnapshots.create");
  const tf = useTranslations("DbSnapshots.field");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <Notice state={state} />
      {reason === null ? null : <p className="seccolor">{reason}</p>}
      <Hidden values={{ databaseId, requestId }} />
      <Field
        name="name"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        disabled={disabled}
        {...(state.fields?.["name"] !== undefined ? { error: tf("invalid") } : {})}
      />
      <SubmitButton variant="primary" disabled={disabled}>
        {t("submit")}
      </SubmitButton>
    </form>
  );
}

function DeleteButton({
  action,
  backupId,
  requestId,
  name,
}: {
  action: SnapshotAction;
  backupId: string;
  requestId: string;
  name: string;
}) {
  const t = useTranslations("DbSnapshots.table");
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <>
      <Button
        size="sm"
        variant="destructive"
        icon="fas fa-trash-alt"
        disabled={name === ""}
        onClick={() => setOpen(true)}
      >
        {t("delete")}
      </Button>
      <Notice state={state} />
      {name === "" ? null : (
        <ConfirmDestroy
          open={open}
          onOpenChange={setOpen}
          resourceName={name}
          title={t("deleteTitle")}
          description={t("deleteBody")}
          pending={pending}
          onConfirm={() => {
            // The dialog checked the typed name; the server checks it again with a fresh sign-in (U10).
            const form = new FormData();
            form.set("backupId", backupId);
            form.set("requestId", requestId);
            form.set("confirmName", name);
            startTransition(() => formAction(form));
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function PlanSelect({
  id,
  plans,
  disabled,
  invalid,
}: {
  id: string;
  plans: DatabaseDetail["restorePlans"];
  disabled: boolean;
  invalid: string | null;
}) {
  const t = useTranslations("DbSnapshots.restore");
  const specLine = useSpecLine();
  return (
    <div className="mb-3">
      <label className="form-label" htmlFor={id}>
        {t("plan")}
      </label>
      <select className="form-select" id={id} name="productId" disabled={disabled}>
        {plans.map((p) => (
          <option key={p.id} value={p.id}>
            {specLine(p.specs)}
          </option>
        ))}
      </select>
      <ul className="seccolor small mt-2 ps-3 mb-0">
        {plans.map((p) => (
          <li key={p.id}>
            {t.rich("planOption", {
              specs: specLine(p.specs),
              price: () => <MoneyText minor={p.priceMinor} />,
            })}
          </li>
        ))}
      </ul>
      {invalid === null ? null : <div className="invalid-feedback d-block">{invalid}</div>}
    </div>
  );
}

function RestoreFromSnapshot({
  action,
  database,
  idPrefix,
}: {
  action: SnapshotAction;
  database: DatabaseDetail;
  idPrefix: string;
}) {
  const t = useTranslations("DbSnapshots.restore");
  const te = useTranslations("DbSnapshots");
  const tf = useTranslations("DbSnapshots.field");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  const ready = database.backups.filter((b) => b.state === "active");
  if (ready.length === 0 || database.restorePlans.length === 0 || database.region === null) {
    return (
      <>
        <h3 className="mergecolor h4">{t("title")}</h3>
        <p className="seccolor">{t("none")}</p>
      </>
    );
  }
  const error = state.error;
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("body")}</p>
      {error === undefined ? null : (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`)
            ? t(`error.${error}`)
            : te.has(`error.${error}`)
              ? te(`error.${error}`)
              : te("error.unavailable")}
        </div>
      )}
      <Hidden values={{ region: database.region }} />
      <div className="mb-3">
        <label className="form-label" htmlFor={`${idPrefix}-snapshot`}>
          {t("snapshot")}
        </label>
        <select className="form-select" id={`${idPrefix}-snapshot`} name="restoreFromBackupId">
          {ready.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <PlanSelect
        id={`${idPrefix}-plan`}
        plans={database.restorePlans}
        disabled={false}
        invalid={state.fields?.["productId"] !== undefined ? t("planInvalid") : null}
      />
      <Field
        name="displayName"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        {...(state.fields?.["displayName"] !== undefined ? { error: tf("invalid") } : {})}
      />
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}

/** `Date` as the value of a datetime-local input in Dhaka (UTC+6), to the minute. */
function dhakaLocal(date: Date): string {
  return new Date(date.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 16);
}

function RestoreToTime({
  action,
  database,
  idPrefix,
}: {
  action: SnapshotAction;
  database: DatabaseDetail;
  idPrefix: string;
}) {
  const t = useTranslations("DbSnapshots.pitr");
  const te = useTranslations("DbSnapshots");
  const tf = useTranslations("DbSnapshots.field");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  if (database.restorePlans.length === 0 || database.region === null) {
    return (
      <>
        <h3 className="mergecolor h4">{t("title")}</h3>
        <p className="seccolor">{t("none")}</p>
      </>
    );
  }
  const error = state.error;
  return (
    <form action={formAction} noValidate>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("body", { days: database.retentionDays })}</p>
      {error === undefined ? null : (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {te.has(`error.${error}`) ? te(`error.${error}`) : te("error.unavailable")}
        </div>
      )}
      <Hidden values={{ region: database.region, restoreSourceId: database.id }} />
      <div className="mb-3">
        <label className="form-label" htmlFor={`${idPrefix}-when`}>
          {t("when")}
        </label>
        <input
          className="form-control"
          type="datetime-local"
          id={`${idPrefix}-when`}
          name="restoreTime"
          min={dhakaLocal(database.pitrWindow.from)}
          max={dhakaLocal(database.pitrWindow.to)}
          required
        />
        <div className="form-text">
          {t("whenHint", {
            from: dhakaLocal(database.pitrWindow.from).replace("T", " "),
            to: dhakaLocal(database.pitrWindow.to).replace("T", " "),
          })}
        </div>
        {state.fields?.["restoreTime"] !== undefined ? (
          <div className="invalid-feedback d-block">{t("whenInvalid")}</div>
        ) : null}
      </div>
      <PlanSelect
        id={`${idPrefix}-plan`}
        plans={database.restorePlans}
        disabled={false}
        invalid={state.fields?.["productId"] !== undefined ? te("restore.planInvalid") : null}
      />
      <Field
        name="displayName"
        label={t("name")}
        hint={te("restore.hint")}
        maxLength={60}
        required
        autoComplete="off"
        {...(state.fields?.["displayName"] !== undefined ? { error: tf("invalid") } : {})}
      />
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}

export function DatabaseBackups({
  database,
  numerals,
  requestIds,
  createAction,
  deleteAction,
  restoreAction,
  pitrAction,
}: {
  database: DatabaseDetail;
  numerals: Numerals;
  /** One id for each form of this page view (R7). */
  requestIds: { create: string; delete: string };
  createAction: SnapshotAction;
  deleteAction: SnapshotAction;
  restoreAction: SnapshotAction;
  pitrAction: SnapshotAction;
}) {
  const t = useTranslations("DbSnapshots");
  const tt = useTranslations("DbSnapshots.table");
  const none = tt("none");
  const priceReady = database.snapshotPrice.state === "ready";
  const perGb =
    database.snapshotPrice.state === "ready" ? database.snapshotPrice.perGbMonthMinor : 0n;
  const running = database.state === "active";
  const stateWord = (state: string): string =>
    state === "active"
      ? tt("stateActive")
      : state === "creating"
        ? tt("stateCreating")
        : tt("stateOther");
  return (
    <>
      <p className="seccolor">{t("intro", { days: database.retentionDays })}</p>
      <p className="seccolor" data-testid="snapshot-price">
        {database.snapshotPrice.state === "ready"
          ? t.rich("price.ready", {
              price: () => <MoneyText minor={perGb} />,
            })
          : t("price.unavailable")}
      </p>
      <CreateForm
        action={createAction}
        databaseId={database.id}
        requestId={requestIds.create}
        disabled={!priceReady || !running}
        reason={!running ? t("create.stopped") : !priceReady ? t("price.unavailable") : null}
      />
      <div className="mt-4">
        {database.backups.length === 0 ? (
          <EmptyState title={t("empty.title")} description={t("empty.body")} />
        ) : (
          <DataTable
            caption={tt("caption")}
            rows={database.backups}
            rowKey={(row) => row.id}
            columns={[
              { key: "name", header: tt("name"), cell: (row) => row.name || none },
              {
                key: "kind",
                header: tt("kind"),
                cell: (row) => (row.final ? tt("final") : tt("manual")),
              },
              {
                key: "size",
                header: tt("size"),
                cell: (row) => (row.sizeGb === null ? none : tt("gb", { size: row.sizeGb })),
              },
              {
                key: "monthly",
                header: tt("monthly"),
                cell: (row) =>
                  row.monthlyMinor === null ? none : <MoneyText minor={row.monthlyMinor} />,
              },
              {
                key: "date",
                header: tt("date"),
                cell: (row) => <DateText value={row.createdAt} numerals={numerals} />,
              },
              { key: "state", header: tt("state"), cell: (row) => stateWord(row.state) },
              {
                key: "actions",
                header: "",
                cell: (row) =>
                  row.final || row.state !== "active" ? null : (
                    <DeleteButton
                      action={deleteAction}
                      backupId={row.id}
                      requestId={requestIds.delete}
                      name={row.name}
                    />
                  ),
              },
            ]}
          />
        )}
      </div>
      <div className="mt-4">
        <RestoreFromSnapshot action={restoreAction} database={database} idPrefix="db-restore" />
      </div>
      <div className="mt-4">
        <RestoreToTime action={pitrAction} database={database} idPrefix="db-pitr" />
      </div>
    </>
  );
}

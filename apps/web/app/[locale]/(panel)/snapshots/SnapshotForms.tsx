"use client";

import { Field, SubmitButton } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "../../../../server/action-state.ts";
import { ActionNotice } from "../servers/[id]/ExtrasForms.tsx";
import type { ExtrasAction } from "../servers/[id]/ExtrasForms.tsx";

/**
 * `createBackup` from the Snapshots page: the same Server Action as the Backups tab of the server,
 * with the server chosen from the customer's own live servers. The server checks the ownership again
 * (R8) and the request id makes a repeat harmless (R7).
 */
export function CreateSnapshotForm({
  action,
  servers,
  requestId,
}: {
  action: ExtrasAction;
  servers: { id: string; name: string }[];
  requestId: string;
}) {
  const t = useTranslations("Snapshots.create");
  const tm = useTranslations("Snapshots.group");
  const tf = useTranslations("Flow");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <form action={formAction} noValidate>
      <h2 className="mergecolor h4">{t("title")}</h2>
      <ActionNotice state={state} />
      <input type="hidden" name="requestId" value={requestId} />
      <div className="mb-3">
        <label className="form-label" htmlFor="snapshot-server">
          {t("server")}
        </label>
        <select className="form-select" id="snapshot-server" name="serverId">
          {servers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name === "" ? tm("unnamed") : s.name}
            </option>
          ))}
        </select>
        {state.fields?.["serverId"] !== undefined ? (
          <div className="invalid-feedback d-block">{tf("field.invalid")}</div>
        ) : null}
      </div>
      <Field
        name="name"
        label={t("name")}
        hint={t("hint")}
        maxLength={60}
        required
        autoComplete="off"
        {...(state.fields?.["name"] !== undefined ? { error: tf("field.invalid") } : {})}
      />
      <SubmitButton variant="primary">{t("submit")}</SubmitButton>
    </form>
  );
}

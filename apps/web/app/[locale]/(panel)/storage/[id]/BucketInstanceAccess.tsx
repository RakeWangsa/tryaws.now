"use client";

import { SubmitButton } from "@tc/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE } from "../../../../../server/action-state.ts";
import type { FormState } from "../../../../../server/action-state.ts";
import type { BucketInstance } from "../../../../../server/bucket-view.ts";

// "Resource access" of a bucket (WPU-G9): the customer's own servers that may use the bucket without
// separate keys. The list comes from the server (the customer's own rows, R8); each button is one
// request with its own id (R7). The state is a word, never a color alone (U11).

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

function Notice({ state }: { state: FormState }) {
  const t = useTranslations("BucketAccess");
  const te = useTranslations("Console");
  const router = useRouter();
  useEffect(() => {
    if (state.done !== undefined) router.refresh();
  }, [state.done, router]);
  if (state.error !== undefined) {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {te.has(`error.${state.error}`) ? te(`error.${state.error}`) : te("error.unavailable")}
      </div>
    );
  }
  if (state.done !== undefined) {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-check-circle me-2" aria-hidden="true" />
        {t("done.instanceAccessQueued")}
      </div>
    );
  }
  return null;
}

function Row({
  action,
  bucketId,
  requestId,
  instance,
}: {
  action: Action;
  bucketId: string;
  requestId: string;
  instance: BucketInstance;
}) {
  const t = useTranslations("BucketAccess.instances");
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);
  return (
    <li className="mb-2">
      <form action={formAction} noValidate className="d-flex flex-wrap align-items-center gap-2">
        <input type="hidden" name="bucketId" value={bucketId} />
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="instanceId" value={instance.id} />
        <input type="hidden" name="access" value={instance.allowed ? "deny" : "allow"} />
        <span className="mergecolor">{instance.name}</span>
        <span className="seccolor">{instance.allowed ? t("allowed") : ""}</span>
        <SubmitButton size="sm" variant={instance.allowed ? "default" : "primary"}>
          {instance.allowed ? t("deny") : t("allow")}
        </SubmitButton>
      </form>
      <Notice state={state} />
    </li>
  );
}

export function BucketInstanceAccess({
  action,
  bucketId,
  requestIds,
  instances,
  mode,
}: {
  action: Action;
  bucketId: string;
  /** One request id for each instance row, made by the page (R7). */
  requestIds: Record<string, string>;
  instances: BucketInstance[];
  mode: "private" | "public" | null;
}) {
  const t = useTranslations("BucketAccess");
  return (
    <section>
      <h3 className="mergecolor h4">{t("mode.title")}</h3>
      <p className="seccolor">{mode === null ? t("mode.unknown") : t(`mode.${mode}`)}</p>
      <h3 className="mergecolor h4 mt-4">{t("instances.title")}</h3>
      <p className="seccolor">{t("instances.intro")}</p>
      {instances.length === 0 ? (
        <p className="seccolor">{t("instances.none")}</p>
      ) : (
        <ul className="list-unstyled">
          {instances.map((instance) => (
            <Row
              key={instance.id}
              action={action}
              bucketId={bucketId}
              requestId={requestIds[instance.id] ?? bucketId}
              instance={instance}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

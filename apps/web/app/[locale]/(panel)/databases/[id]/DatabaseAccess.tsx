"use client";

import { Button, CopyField, SecretReveal } from "@tc/ui";
import { useTranslations } from "next-intl";
import { useState } from "react";

// The Connect tab of a database (16.10 `revealDatabasePassword`, U9). Client Component: it holds the
// password in memory for the 60 seconds of the window and drops it when SecretReveal says the window
// ended. The password is not in the server HTML, in an attribute, in storage or in a log. The action
// is the Server Action `revealDatabasePasswordAction`; a test passes a fake. Public access is shown as
// off with its warning: the switch is not built (no operation kind yet).

export type DatabaseRevealResult =
  { ok: true; username: string; password: string } | { ok: false; error: string };

export function DatabaseAccess({
  resourceId,
  running,
  action,
  initial = null,
}: {
  resourceId: string;
  /** False when the database is not running: the button is not offered. */
  running: boolean;
  action: (form: FormData) => Promise<DatabaseRevealResult>;
  /** Tests only: a state that is normally reached by the button. */
  initial?: { username: string; password: string } | null;
}) {
  const t = useTranslations("Databases.detail.access");
  const [secret, setSecret] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [gone, setGone] = useState(false);

  async function reveal(form: FormData): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await action(form);
      if (result.ok) {
        setSecret({ username: result.username, password: result.password });
        setGone(false);
      } else {
        setError(result.error);
      }
    } catch {
      setError("unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <h3 className="mergecolor h4">{t("title")}</h3>
      <p className="seccolor">{t("intro")}</p>
      <div className="alert alert-warning text-start" role="note">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("warning")}
      </div>
      {error !== null ? (
        <div className="alert alert-danger text-start" role="alert">
          <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
          {t.has(`error.${error}`) ? t(`error.${error}`) : t("error.unavailable")}
        </div>
      ) : null}
      {secret !== null ? (
        <>
          <CopyField label={t("userName")} value={secret.username} />
          <SecretReveal
            label={t("password")}
            secret={secret.password}
            onHidden={() => {
              setSecret(null);
              setGone(true);
            }}
          />
        </>
      ) : !running ? (
        <p className="seccolor">{t("notReady")}</p>
      ) : (
        <form action={reveal}>
          <input type="hidden" name="resourceId" value={resourceId} />
          {gone ? <p className="seccolor">{t("gone")}</p> : null}
          <Button type="submit" variant="primary" icon="fas fa-key" pending={pending}>
            {pending ? t("working") : t("show")}
          </Button>
        </form>
      )}
      <h3 className="mergecolor h4 mt-4">{t("publicMode.title")}</h3>
      <p className="seccolor">{t("publicMode.off")}</p>
      <div className="alert alert-warning text-start" role="note">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("publicMode.warning")}
      </div>
      <p className="seccolor">{t("publicMode.unavailable")}</p>
    </div>
  );
}

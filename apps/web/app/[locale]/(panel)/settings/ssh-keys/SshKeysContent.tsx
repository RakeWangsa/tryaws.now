import { Card, DataTable, DateText, EmptyState } from "@tc/ui";
import type { SshKey } from "@tc/db";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { SshKeysScreen } from "../../../../../server/servers-view.ts";
import { AddKeyForm, RemoveKeyButton } from "./KeyForms.tsx";

// The content of /settings/ssh-keys: the list (DataTable), the add form and the remove dialog (U10).
// Synchronous, so it renders in a test without a request. Only public keys and their fingerprints
// are shown; the key text itself is not echoed.

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export function SshKeysContent({
  numerals,
  screen,
  addAction,
  removeAction,
}: {
  numerals: Numerals;
  screen: SshKeysScreen;
  addAction: Action;
  removeAction: Action;
}) {
  const t = useTranslations("SshKeys");

  if (screen.state === "flag_off") {
    return <EmptyState title={t("flagOff.title")} description={t("flagOff.body")} />;
  }

  const columns = [
    { key: "name", header: t("list.name"), cell: (row: SshKey) => row.name },
    {
      key: "fingerprint",
      header: t("list.fingerprint"),
      cell: (row: SshKey) => <code className="seccolor">{row.fingerprint}</code>,
    },
    {
      key: "added",
      header: t("list.added"),
      cell: (row: SshKey) => <DateText value={row.createdAt} numerals={numerals} />,
    },
    {
      key: "remove",
      header: "",
      cell: (row: SshKey) => (
        <RemoveKeyButton action={removeAction} keyId={row.id} keyName={row.name} />
      ),
    },
  ];

  return (
    <>
      <p className="seccolor mb-4">{t("intro")}</p>
      {screen.keys.length === 0 ? (
        <EmptyState title={t("list.empty.title")} description={t("list.empty.body")} />
      ) : (
        <Card className="mb-4">
          <DataTable
            caption={t("list.caption")}
            columns={columns}
            rows={screen.keys}
            rowKey={(row) => row.id}
          />
        </Card>
      )}
      <Card title={t("add.title")}>
        <AddKeyForm action={addAction} />
      </Card>
    </>
  );
}

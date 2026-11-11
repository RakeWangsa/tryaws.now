import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateText,
  EmptyState,
  Field,
  FormBlock,
  type DataTableColumn,
} from "@tc/ui";
import { localePath, type Locale } from "@tc/ui/runtime";
import { adminsAction } from "../../server/admins-actions.ts";
import type { AdminListRow, AdminListView } from "../../server/admins-data.ts";
import type { Loaded } from "../../server/money-data.ts";

// 16.12 /admins (superadmin only): the admin users, an invitation, and per row: change the role,
// disable or enable, reset the second factor. Every form has a reason and none has a field that names
// the acting admin or an approver: that is the verified session (R10). No client script (U-rules).
export const ADMIN_RESULT_CODES = [
  "ok",
  "replayed",
  "invalid",
  "denied",
  "not_found",
  "conflict",
  "self",
  "rate_limited",
  "unavailable",
  "directoryFailed",
] as const;
export type AdminResultCode = (typeof ADMIN_RESULT_CODES)[number];

export function adminResultOf(value: unknown): AdminResultCode | null {
  return typeof value === "string" && (ADMIN_RESULT_CODES as readonly string[]).includes(value)
    ? (value as AdminResultCode)
    : null;
}

const ROLES = ["support", "finance", "ops", "superadmin"] as const;

function ResultLine({ result }: { result: AdminResultCode | null }) {
  const t = useTranslations("AdminUsers.result");
  if (result === null) return null;
  return (
    <p role="status" className="mb-3">
      <i
        className={
          result === "ok" || result === "replayed"
            ? "fas fa-check-circle me-1"
            : "fas fa-exclamation-circle me-1"
        }
        aria-hidden="true"
      />
      {t(result)}
    </p>
  );
}

function RoleSelect({ id, value }: { id: string; value?: string }) {
  const t = useTranslations("AdminUsers");
  return (
    <div className="position-relative mb-3">
      <label className="seccolor" htmlFor={id}>
        {t("change.role")}
      </label>
      <select id={id} name="role" className="form-control" defaultValue={value ?? "support"}>
        {ROLES.map((role) => (
          <option key={role} value={role}>
            {t(`roles.${role}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReasonField({ suffix }: { suffix: string }) {
  const t = useTranslations("AdminUsers.reason");
  return (
    <Field
      name="reason"
      id={`reason-${suffix}`}
      label={t("label")}
      hint={t("hint")}
      required
      maxLength={500}
      autoComplete="off"
    />
  );
}

function RowActions({ locale, row, you }: { locale: Locale; row: AdminListRow; you: boolean }) {
  const t = useTranslations("AdminUsers");
  return (
    <form action={adminsAction}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="id" value={row.id} />
      <FormBlock>
        {you ? null : <RoleSelect id={`role-${row.id}`} value={row.role} />}
        <ReasonField suffix={row.id} />
      </FormBlock>
      {you ? (
        <p className="form-text seccolor">{t("change.selfNote")}</p>
      ) : (
        <p className="mb-2">
          <Button type="submit" name="kind" value="setAdminRole" variant="primary" size="sm">
            {t("change.setRole")}
          </Button>{" "}
          {row.status === "active" ? (
            <Button type="submit" name="kind" value="disableAdmin" variant="destructive" size="sm">
              {t("change.disable")}
            </Button>
          ) : (
            <Button type="submit" name="kind" value="enableAdmin" variant="secondary" size="sm">
              {t("change.enable")}
            </Button>
          )}{" "}
        </p>
      )}
      <Button type="submit" name="kind" value="resetAdminMfa" variant="tertiary" size="sm">
        {t("change.resetMfa")}
      </Button>
      <span className="form-text seccolor d-block">{t("change.resetMfaHint")}</span>
    </form>
  );
}

function AdminTable({ locale, view, me }: { locale: Locale; view: AdminListView; me: string }) {
  const t = useTranslations("AdminUsers");
  const columns: DataTableColumn<AdminListRow>[] = [
    {
      key: "email",
      header: t("table.email"),
      cell: (row) => (
        <>
          {row.email ?? t("unknown")}
          {row.id === me ? <> ({t("you")})</> : null}
          <span className="form-text seccolor d-block" title={row.id}>
            #{row.id.slice(0, 8)}
          </span>
        </>
      ),
    },
    { key: "role", header: t("table.role"), cell: (row) => t(`roles.${row.role}`) },
    {
      key: "status",
      header: t("table.status"),
      cell: (row) => (
        <Badge tone={row.status === "active" ? "purple" : "grey"}>
          {t(`status.${row.status}`)}
        </Badge>
      ),
    },
    {
      key: "lastSignIn",
      header: t("table.lastSignIn"),
      cell: (row) =>
        view.directory === "off" ? (
          t("unknown")
        ) : row.lastSignInAt === null ? (
          t("never")
        ) : (
          <DateText value={row.lastSignInAt} variant="datetime" />
        ),
    },
    {
      key: "totp",
      header: t("table.totp"),
      cell: (row) =>
        row.totpEnrolled === null
          ? t("totp.unknown")
          : row.totpEnrolled
            ? t("totp.yes")
            : t("totp.no"),
    },
    {
      key: "created",
      header: t("table.created"),
      cell: (row) => <DateText value={row.createdAt} variant="datetime" />,
    },
    {
      key: "action",
      header: t("table.action"),
      cell: (row) => <RowActions locale={locale} row={row} you={row.id === me} />,
    },
  ];
  if (view.rows.length === 0) {
    return <EmptyState title={t("empty.title")} description={t("empty.body")} />;
  }
  return (
    <DataTable
      caption={t("table.caption")}
      columns={columns}
      rows={view.rows}
      rowKey={(row) => row.id}
      prevHref={undefined}
      nextHref={
        view.nextAfter === null ? null : `${localePath(locale, "/admins")}?after=${view.nextAfter}`
      }
    />
  );
}

function InviteForm({ locale }: { locale: Locale }) {
  const t = useTranslations("AdminUsers.invite");
  return (
    <Card title={t("title")}>
      <p>{t("intro")}</p>
      <form action={adminsAction}>
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="kind" value="inviteAdmin" />
        <FormBlock>
          <Field
            name="email"
            id="invite-email"
            type="email"
            label={t("email")}
            required
            maxLength={254}
            autoComplete="off"
          />
          <RoleSelect id="invite-role" />
          <ReasonField suffix="invite" />
        </FormBlock>
        <Button type="submit" variant="primary" size="sm">
          {t("submit")}
        </Button>
      </form>
    </Card>
  );
}

export interface AdminsViewProps {
  locale: Locale;
  me: string;
  list: Loaded<AdminListView>;
  result: AdminResultCode | null;
}

export function AdminsView({ locale, me, list, result }: AdminsViewProps) {
  const t = useTranslations("AdminUsers");
  return (
    <>
      <h2 className="h4 mergecolor">{t("title")}</h2>
      <p className="form-text seccolor">{t("intro")}</p>
      <ResultLine result={result} />
      {list.kind === "ok" ? (
        <>
          {list.value.directory === "off" ? (
            <p className="form-text seccolor">{t("directoryOff")}</p>
          ) : null}
          <AdminTable locale={locale} view={list.value} me={me} />
        </>
      ) : (
        <EmptyState title={t("unavailable.title")} description={t("unavailable.body")} />
      )}
      <InviteForm locale={locale} />
    </>
  );
}

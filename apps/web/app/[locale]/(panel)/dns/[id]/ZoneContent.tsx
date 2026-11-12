import { Button, Card, DataTable, EmptyState, StateBadge } from "@tc/ui";
import type { BadgeState } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { RecordView, ZoneScreen, ZoneView } from "../../../../../server/dns-view.ts";
import {
  DeleteRecordForm,
  RecordForm,
  type DnsAction,
  type EditingRecord,
} from "./RecordForms.tsx";

// The content of /dns/[id] (WPU-G4, Amazon Route 53): the name servers, the records of the zone and the
// editor for A, AAAA, CNAME, MX, TXT, SRV and CAA. The apex NS and SOA are listed and read-only. A zone
// of another customer and a missing one give the same answer (R8). Nothing here shows the hosted zone
// id, an account id, an ARN or the text of an AWS error (U6). Synchronous, so it renders in a test
// without a request.

const BADGE_OF: Record<string, BadgeState> = {
  creating: "creating",
  active: "running",
  stopped: "stopped",
  suspended: "stopped",
  failed: "problem",
};

export function ZoneStateBadge({ state }: { state: string }) {
  const t = useTranslations("Dns.state");
  const known = Object.hasOwn(BADGE_OF, state);
  return (
    <StateBadge
      state={known ? (BADGE_OF[state] as BadgeState) : "problem"}
      label={known ? t(state) : t("failed")}
    />
  );
}

function Banner({ zone }: { zone: ZoneView }) {
  const t = useTranslations("Dns.detail");
  if (zone.lastChange === null) return null;
  if (zone.lastChange === "working") {
    return (
      <div className="alert alert-info text-start" role="status">
        <i className="fas fa-hourglass-half me-2" aria-hidden="true" />
        {t("change.working")}
      </div>
    );
  }
  if (zone.lastChange === "failed") {
    return (
      <div className="alert alert-danger text-start" role="alert">
        <i className="fas fa-exclamation-triangle me-2" aria-hidden="true" />
        {t("change.failed")}
      </div>
    );
  }
  return null;
}

export function ZoneContent({
  locale,
  screen,
  editing,
  saveAction,
  deleteAction,
}: {
  locale: Locale;
  screen: ZoneScreen | null;
  /** The record the customer chose to edit (from ?edit=), already matched against the list. */
  editing: EditingRecord | null;
  saveAction: DnsAction;
  deleteAction: DnsAction;
}) {
  const t = useTranslations("Dns");
  const listHref = localePath(locale, "/dns");

  if (screen === null) {
    return (
      <EmptyState
        title={t("detail.notFound.title")}
        description={t("detail.notFound.body")}
        action={
          <Button variant="primary" href={listHref}>
            {t("detail.back")}
          </Button>
        }
      />
    );
  }
  if (screen.state === "flag_off") {
    return (
      <EmptyState
        title={t("flagOff.title")}
        description={t("flagOff.body")}
        action={
          <Button variant="primary" href={listHref}>
            {t("detail.back")}
          </Button>
        }
      />
    );
  }

  const { zone } = screen;
  const here = localePath(locale, `/dns/${encodeURIComponent(zone.id)}`);
  const editHref = (r: RecordView): string =>
    `${here}?edit=${encodeURIComponent(`${r.type}:${r.relative}`)}`;
  const notEditable = zone.canEdit
    ? null
    : zone.busy
      ? t("detail.notEditable.busy")
      : zone.state === "creating"
        ? t("detail.notEditable.creating")
        : t("detail.notEditable.state");

  return (
    <>
      <p className="mb-3">
        <a href={listHref}>
          <i className="fas fa-arrow-left me-1" aria-hidden="true" />
          {t("detail.back")}
        </a>
      </p>
      <div className="d-flex flex-wrap align-items-center gap-3 mb-3">
        <h1 className="h3 mergecolor mb-0">{zone.name}</h1>
        <ZoneStateBadge state={zone.state} />
      </div>
      <p className="seccolor">{t("awsNote")}</p>

      <Card as="section" title={t("detail.nameServers.title")} className="mb-4">
        {zone.nameServers.length === 0 ? (
          <p className="seccolor mb-0">{t("detail.nameServers.none")}</p>
        ) : (
          <>
            <p className="seccolor">{t("detail.nameServers.body")}</p>
            <ul className="mb-0">
              {zone.nameServers.map((ns) => (
                <li key={ns}>
                  <code>{ns}</code>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Banner zone={zone} />

      {zone.records === null ? (
        <EmptyState title={t("detail.stale.title")} description={t("detail.stale.body")} />
      ) : (
        <>
          {zone.records.length === 0 ? (
            <p className="seccolor">{t("detail.noRecords")}</p>
          ) : (
            <DataTable
              caption={t("detail.table.caption")}
              rows={zone.records}
              rowKey={(r) => `${r.type}:${r.name}`}
              columns={[
                {
                  key: "name",
                  header: t("detail.table.name"),
                  cell: (r: RecordView) => r.relative,
                },
                { key: "type", header: t("detail.table.type"), cell: (r: RecordView) => r.type },
                { key: "ttl", header: t("detail.table.ttl"), cell: (r: RecordView) => r.ttl },
                {
                  key: "value",
                  header: t("detail.table.value"),
                  cell: (r: RecordView) =>
                    r.values.map((v, i) => (
                      <div key={`${i}:${v}`}>
                        <code>{v}</code>
                      </div>
                    )),
                },
                {
                  key: "actions",
                  header: t("detail.table.actions"),
                  cell: (r: RecordView) =>
                    r.readOnly ? (
                      <span className="seccolor">{t("detail.table.readOnly")}</span>
                    ) : zone.canEdit ? (
                      <div className="d-flex flex-wrap gap-2">
                        <Button
                          variant="default"
                          size="sm"
                          href={editHref(r)}
                          aria-label={t("detail.table.editLabel", {
                            name: r.relative,
                            type: r.type,
                          })}
                        >
                          {t("detail.table.edit")}
                        </Button>
                        <DeleteRecordForm
                          action={deleteAction}
                          zoneId={zone.id}
                          requestId={zone.requestId}
                          relative={r.relative}
                          type={r.type}
                          label={t("detail.table.deleteLabel", {
                            name: r.relative,
                            type: r.type,
                          })}
                          buttonText={t("detail.table.delete")}
                        />
                      </div>
                    ) : null,
                },
              ]}
            />
          )}
          {notEditable !== null ? (
            <div className="alert alert-info text-start mt-3" role="note">
              <i className="fas fa-info-circle me-2" aria-hidden="true" />
              {notEditable}
            </div>
          ) : (
            <RecordForm
              key={editing === null ? "add" : `${editing.type}:${editing.relative}`}
              action={saveAction}
              zoneId={zone.id}
              requestId={zone.requestId}
              editing={editing}
              cancelHref={here}
            />
          )}
        </>
      )}
    </>
  );
}

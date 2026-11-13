import type { ReactNode } from "react";
import { Button, Card, CopyField, EmptyState, StatTile, Tabs, formatDate } from "@tc/ui";
import { localePath } from "@tc/ui/runtime";
import type { Locale } from "@tc/ui/runtime";
import { useTranslations } from "next-intl";
import type { FormState } from "../../../../../server/action-state.ts";
import type { BucketDetail } from "../../../../../server/bucket-view.ts";
import { BucketState, useRegionLabel } from "../StorageParts.tsx";
import { BucketKeys } from "./BucketKeys.tsx";
import type { KeyResult } from "./BucketKeys.tsx";
import type { KeyView as KeyRow } from "../../../../../server/bucket-keys.ts";
import { AccessForms, DeleteKeyForm, DestroyPanel } from "./StorageForms.tsx";

// The content of /storage/[id] (16.10): a header and the tabs Overview, Access, Access keys and
// Delete. A bucket of another customer and a missing one give the same answer (R8). The bucket name
// and its address are shown because the customer needs them (U6); nothing here shows an account id,
// an ARN or a name the customer typed as an AWS name (R11). What the web tier cannot read (usage, the
// current access mode, the list of keys) says so (16.13).

type Numerals = "beng" | "latn";
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

// Used when no Server Action is passed (the static mockup states): the form refuses (R16).
const refuse: Action = async () => ({ error: "unavailable" });
const refuseKey = async (): Promise<KeyResult> => ({ ok: false, error: "unavailable" });

export function StorageDetailContent({
  locale,
  numerals,
  bucket,
  requestId,
  accessAction = refuse,
  deleteKeyAction = refuse,
  destroyAction = refuse,
  createKeyAction = refuseKey,
  keys: keyList = null,
  defaultTab,
  extra = null,
  renewal = null,
}: {
  locale: Locale;
  numerals: Numerals;
  bucket: BucketDetail | null;
  /** One id for the forms of this page view (R7). */
  requestId: string;
  accessAction?: Action;
  deleteKeyAction?: Action;
  destroyAction?: Action;
  createKeyAction?: (form: FormData) => Promise<KeyResult>;
  /** The keys of the bucket (WPU-N2); null when the list could not be read: the tab says so (R16). */
  keys?: readonly KeyRow[] | null;
  defaultTab?: string;
  /** The versioning form (WPU-G7), built by the page. */
  extra?: ReactNode;
  /** WPU-Z14: the auto-renew switch, built by the page; shown at the end of the Overview tab. */
  renewal?: ReactNode;
}) {
  const t = useTranslations("Storage");
  const regionLabel = useRegionLabel();
  const listHref = localePath(locale, "/storage");

  if (bucket === null) {
    // WPU-Z14: with the flag of the family off the page has no detail, but an "off only" auto-renew switch
    // (built by the page while auto-renew is still on) lets the customer stop the renewals.
    return (
      <>
        <EmptyState
          title={t("detail.notFound.title")}
          description={t("detail.notFound.body")}
          action={
            <Button variant="primary" href={listHref}>
              {t("detail.back")}
            </Button>
          }
        />
        {renewal}
      </>
    );
  }

  const active = bucket.state === "active";
  const accessValue =
    bucket.accessMode === null ? t("access.unknown") : t(`access.${bucket.accessMode}`);

  const overview = (
    <div className="row g-3">
      <div className="col-12">
        {bucket.bucketName === null ? null : (
          <CopyField
            label={t("detail.overview.bucketName")}
            value={bucket.bucketName}
            hint={t("detail.overview.bucketNameHint")}
          />
        )}
      </div>
      {bucket.address === null ? null : (
        <div className="col-12">
          <CopyField label={t("detail.overview.address")} value={bucket.address} />
        </div>
      )}
      <div className="col-12 col-md-6">
        <StatTile value={regionLabel(bucket.region)} description={t("detail.overview.location")} />
      </div>
      <div className="col-12 col-md-6">
        <StatTile value={accessValue} description={t("detail.overview.access")} />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={t("list.none")}
          description={`${t("detail.overview.usage")}: ${t("detail.overview.usageUnavailable")}`}
        />
      </div>
      <div className="col-12 col-md-6">
        <StatTile
          value={formatDate(bucket.createdAt, { locale, numerals })}
          description={t("detail.overview.created")}
        />
      </div>
      {bucket.accessMode === null ? (
        <div className="col-12">
          <p className="seccolor">{t("detail.overview.accessUnknown")}</p>
        </div>
      ) : null}
      <div className="col-12">
        <h3 className="mergecolor h4">{t("detail.overview.requests")}</h3>
        {bucket.requests.length === 0 ? (
          <p className="seccolor">{t("detail.overview.requestsNone")}</p>
        ) : (
          <ul className="list-unstyled">
            {bucket.requests.map((request) => (
              <li key={request.id}>
                {t(`detail.overview.request.${request.kind}`)}
                {": "}
                {t.has(`opState.${request.state}`)
                  ? t(`opState.${request.state}`)
                  : t("opState.queued")}
                {", "}
                {formatDate(request.createdAt, { locale, numerals })}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );

  const access = (
    <>
      <h3 className="mergecolor h4">{t("detail.access.title")}</h3>
      <AccessForms
        action={accessAction}
        bucketId={bucket.id}
        requestId={requestId}
        allowed={active}
      />
      {extra === null ? null : <div className="mt-4">{extra}</div>}
    </>
  );

  const keys = (
    <>
      <BucketKeys
        bucketId={bucket.id}
        requestId={requestId}
        active={active}
        action={createKeyAction}
      />
      <h3 className="mergecolor h4 mt-4">{t("detail.keys.listTitle")}</h3>
      {keyList === null ? (
        <p className="seccolor">{t("detail.keys.listUnavailable")}</p>
      ) : keyList.length === 0 ? (
        <p className="seccolor">{t("detail.keys.listEmpty")}</p>
      ) : (
        <div className="table-responsive-sm">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("detail.keys.listKeyId")}</th>
                <th scope="col">{t("detail.keys.listStatus")}</th>
                <th scope="col">{t("detail.keys.listCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {keyList.map((key) => (
                <tr key={key.accessKeyId}>
                  <td>{key.accessKeyId}</td>
                  <td>{t(`detail.keys.status.${key.status}`)}</td>
                  <td>
                    {key.createdAt === null ? "-" : formatDate(key.createdAt, { locale, numerals })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <hr />
      <DeleteKeyForm
        action={deleteKeyAction}
        bucketId={bucket.id}
        requestId={requestId}
        allowed={active}
      />
      <h3 className="mergecolor h4 mt-4">{t("detail.keys.rotateTitle")}</h3>
      <p className="seccolor">{t("detail.keys.rotateSteps")}</p>
    </>
  );

  const live =
    bucket.state === "active" || bucket.state === "stopped" || bucket.state === "suspended";
  const destroy = (
    <>
      <h3 className="mergecolor h4">{t("detail.destroy.title")}</h3>
      <DestroyPanel
        action={destroyAction}
        bucketId={bucket.id}
        requestId={requestId}
        resourceName={bucket.name}
        disabled={!live}
        open={bucket.destroyOpen}
      />
    </>
  );

  return (
    <>
      <p className="mb-3">
        <a href={listHref}>
          <i className="fas fa-arrow-left me-1" aria-hidden="true" />
          {t("detail.back")}
        </a>
      </p>
      <Card className="mb-4">
        <h1 className="mergecolor h3 mb-2">{bucket.name === "" ? t("list.none") : bucket.name}</h1>
        <div className="d-flex flex-wrap align-items-center gap-3">
          <BucketState state={bucket.state} />
          <span className="seccolor">{t("detail.header.aws")}</span>
        </div>
      </Card>
      <Card>
        <Tabs
          label={t("detail.tabsLabel")}
          tabs={[
            {
              id: "overview",
              title: t("detail.tab.overview"),
              content:
                renewal === null ? (
                  overview
                ) : (
                  <>
                    {overview}
                    {renewal}
                  </>
                ),
            },
            { id: "access", title: t("detail.tab.access"), content: access },
            { id: "keys", title: t("detail.tab.keys"), content: keys },
            { id: "destroy", title: t("detail.tab.destroy"), content: destroy },
          ]}
          {...(defaultTab !== undefined && ["access", "keys", "destroy"].includes(defaultTab)
            ? { defaultId: defaultTab }
            : {})}
        />
      </Card>
    </>
  );
}

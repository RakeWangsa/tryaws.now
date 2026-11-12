import { newUuidV7 } from "@tc/db";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { routing } from "../../../../../i18n/routing.ts";
import { loadBucketDetail } from "../../../../../server/bucket-view.ts";
import { startPanelPage } from "../../../../../server/panel-page.ts";
import { PanelFrame, numeralsFor } from "../../PanelFrame.tsx";
import { BucketVersioningForm } from "../../_console/ConsoleForms.tsx";
import { StorageDetailContent } from "./StorageDetailContent.tsx";
import {
  deleteAccessKeyAction,
  destroyBucketAction,
  setBucketAccessAction,
  setBucketVersioningAction,
} from "./actions.ts";
import { createBucketKeyAction } from "./key-actions.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const t = await getTranslations({ locale });
  return { title: t("Storage.detail.meta.title"), robots: { index: false, follow: false } };
}

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** /storage/[id] (16.10): header and tabs. The id of another customer's bucket answers like a missing one (R8). */
export default async function StorageDetailPage({ params, searchParams }: Props) {
  const { locale, id } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  const query = await searchParams;
  const path = `/storage/${encodeURIComponent(id)}`;
  const panel = await startPanelPage(path);
  const bucket = await loadBucketDetail(panel.session, id);
  const tab = one(query["tab"]);
  return (
    <PanelFrame locale={locale} path={path} currentId="objectStorage" panel={panel}>
      <StorageDetailContent
        locale={locale}
        numerals={numeralsFor(locale, panel)}
        bucket={bucket}
        requestId={newUuidV7()}
        accessAction={setBucketAccessAction}
        deleteKeyAction={deleteAccessKeyAction}
        destroyAction={destroyBucketAction}
        createKeyAction={createBucketKeyAction}
        {...(bucket !== null && bucket.state === "active"
          ? {
              extra: (
                <BucketVersioningForm
                  action={setBucketVersioningAction}
                  bucketId={bucket.id}
                  requestId={newUuidV7()}
                  suspendRequestId={newUuidV7()}
                  versioning={bucket.versioning ?? null}
                />
              ),
            }
          : {})}
        {...(tab !== undefined ? { defaultTab: tab } : {})}
      />
    </PanelFrame>
  );
}

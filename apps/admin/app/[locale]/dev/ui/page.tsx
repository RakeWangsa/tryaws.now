import { KitGallery } from "@tc/ui/gallery";
import { isDevUiEnabled, isLocale } from "@tc/ui/runtime";
import { notFound } from "next/navigation";

type Props = { params: Promise<{ locale: string }> };

/** The component gallery (16.16). Not served in production; the check runs on every request. */
export default async function DevUiPage({ params }: Props) {
  if (!isDevUiEnabled(process.env)) notFound();
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  return <KitGallery app="admin" />;
}

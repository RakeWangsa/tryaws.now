import { ShellDemo, resolveGalleryShell } from "@tc/ui/gallery";
import { isDevUiEnabled, isLocale } from "@tc/ui/runtime";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ locale: string; shell: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
};

/** The admin shell with sample content (16.12). The shell must belong to this app; the demo checks `page`. */
export default async function DevUiShellPage({ params, searchParams }: Props) {
  if (!isDevUiEnabled(process.env)) notFound();
  const { locale, shell } = await params;
  const known = resolveGalleryShell("admin", shell);
  if (known === null || !isLocale(locale)) notFound();
  const { page } = await searchParams;
  return (
    <ShellDemo shell={known} locale={locale} page={typeof page === "string" ? page : undefined} />
  );
}

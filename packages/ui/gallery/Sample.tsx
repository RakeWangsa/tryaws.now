import { useTranslations } from "next-intl";
import type { ReactElement, ReactNode } from "react";

/**
 * One sample of the gallery: `div[data-gallery=<export name>]` with an h3 title and a caption that
 * names the mockup page and class the component comes from. `titleKey` is the message key of the
 * sample (`Gallery.samples.card`); its `title` and `source` leaves are read.
 */
export function Sample({
  name,
  titleKey,
  children,
}: {
  name: string;
  titleKey: string;
  children: ReactNode;
}): ReactElement {
  const t = useTranslations();
  const gallery = useTranslations("Gallery");
  return (
    <div data-gallery={name} className="tc-gallery-sample mb-5">
      <h3 className="h5 mergecolor mb-1">{t(`${titleKey}.title`)}</h3>
      <p className="tc-gallery-source small mb-3">
        {gallery("mockup")}: <code className="tc-gallery-code">{t(`${titleKey}.source`)}</code>
      </p>
      {children}
    </div>
  );
}

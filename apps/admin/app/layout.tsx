import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import type { ReactNode } from "react";
import { loadKitMessages } from "@tc/ui/messages";
import { DEFAULT_LOCALE, isLocale } from "@tc/ui/runtime";
import {
  THEME_CONTENT_CLASSES,
  THEME_STYLESHEETS,
  fontPreloads,
  themeAttributes,
} from "@tc/ui/theme";

// The proxy sets a nonce per request, so no page of this app can be built ahead of time.
export const dynamic = "force-dynamic";

// The operator console is not for search engines.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  icons: { icon: "/brand/symbol.svg" },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const requested = await getLocale();
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  // Read once: it keeps the route dynamic even if the config changes. Next puts the nonce on its
  // own scripts from the request header, so the value itself is not used here.
  void (await headers()).get("x-nonce");

  return (
    <html lang={locale}>
      <head>
        {THEME_STYLESHEETS.map((href) => (
          <link key={href} rel="stylesheet" href={href} />
        ))}
        {fontPreloads(locale).map((font) => (
          <link
            key={font.href}
            rel="preload"
            as={font.as}
            type={font.type}
            crossOrigin={font.crossOrigin}
            href={font.href}
          />
        ))}
      </head>
      <body {...themeAttributes("admin")}>
        <div className={THEME_CONTENT_CLASSES}>
          <NextIntlClientProvider locale={locale} messages={loadKitMessages(locale)}>
            {children}
          </NextIntlClientProvider>
        </div>
      </body>
    </html>
  );
}

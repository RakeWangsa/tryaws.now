import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { DEFAULT_LOCALE, isLocale } from "@tc/ui/runtime";
import {
  THEME_CONTENT_CLASSES,
  THEME_STYLESHEETS,
  fontPreloads,
  themeAttributes,
} from "@tc/ui/theme";

export const metadata: Metadata = { icons: { icon: "/brand/symbol.svg" } };

// Every route is rendered per request: the proxy puts a fresh CSP nonce on each one (U4).
export const dynamic = "force-dynamic";

/** The root of every page (16.4): theme sheets, font preloads, body attributes, one content div. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const requested = await getLocale();
  const locale = isLocale(requested) ? requested : DEFAULT_LOCALE;
  const messages = await getMessages({ locale });
  // Next reads the nonce from the request's CSP header and puts it on its own scripts. Reading the
  // header here also makes the route dynamic should the config above ever change.
  (await headers()).get("x-nonce");

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
            href={font.href}
            as={font.as}
            type={font.type}
            crossOrigin={font.crossOrigin}
          />
        ))}
      </head>
      <body {...themeAttributes("web")}>
        <div className={THEME_CONTENT_CLASSES}>
          <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Dhaka">
            {children}
          </NextIntlClientProvider>
        </div>
      </body>
    </html>
  );
}

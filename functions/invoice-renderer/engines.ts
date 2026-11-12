import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Locale } from "@tc/core";
import type { PdfRenderer, PdfStore } from "./handler";

// IMPLEMENTED (WPU-D1): the PDF engine and the store. Both fail closed (R16): no engine, no font, no bucket
// or any error produces no PDF and no half result, and every error text is fixed (it never carries the
// HTML, an id or the text of the underlying error, R14).
//
//  - PdfRenderer: headless Chromium (puppeteer-core with the @sparticuz/chromium build for AWS Lambda,
//    reasons recorded in JOURNEY.md, R17) with the packaged Noto Sans Bengali (3 and 9.3). The engine is
//    the FIRST line of defence and does not rely on the handler's markup scan (the second line):
//      * JavaScript is disabled before any content is set;
//      * the page is offline, request interception is on and EVERY request is aborted (http, https, file,
//        data, about, blob, ws), and the document itself arrives through setContent, which is not a
//        request;
//      * the browser is launched with a fixed argument set, resolves no host name and uses no proxy;
//      * there is no navigation to a URL anywhere: the only input is the HTML string that the handler
//        checked;
//      * one browser, one page per render; the browser is always closed.
//    The function also has no route out of its network at all (infra/stacks/network.ts), a third line.
//    Real Chromium is not started in unit tests: they inject a fake through createPdfRenderer. Cold start,
//    Bengali shaping, memory and the interception are staging VERIFY items (JOURNEY.md).
//  - PdfStore: one PutObject to the invoices bucket (INVOICES_BUCKET), for the derived key only.

export const RENDER_TIMEOUT_MS = 20_000;
export const NAVIGATION_TIMEOUT_MS = 15_000;

const ERR_ENGINE = "invoice-renderer: the pdf engine is unavailable";
const ERR_FONT = "invoice-renderer: the packaged font is missing";
const ERR_TIMEOUT = "invoice-renderer: the render timed out";
const ERR_RENDER = "invoice-renderer: render failed";
const ERR_BUCKET = "invoice-renderer: the invoices bucket is not configured";
const ERR_KEY = "invoice-renderer: the object key is not an invoice key";
const ERR_STORE = "invoice-renderer: the store failed";

// The fonts are copied next to the bundle (infra/stacks/workers.ts, copyFiles) into /var/task/fonts, a
// folder that the fonts.conf of @sparticuz/chromium lists. Chromium reads them through fontconfig, so no
// font is fetched (a font URL would be a request and is aborted like every other).
export const FONTS_DIR = "/var/task/fonts";
export const BENGALI_FONT_FILES: readonly string[] = [
  "NotoSansBengali-Regular.ttf",
  "NotoSansBengali-Bold.ttf",
];

// Fixed arguments, nothing built from the event. The sandbox flags are here because AWS Lambda cannot
// run the Chromium sandbox (no user namespaces and no setuid helper): that is why the four flags marked
// "Lambda requires it" are present, as the @sparticuz/chromium documentation requires on Lambda. The
// unsafe flags of its default list (web security off, insecure content allowed, site isolation off)
// are NOT used.
export const LAUNCH_ARGS: readonly string[] = [
  "--no-sandbox", // Lambda requires it
  "--disable-setuid-sandbox", // Lambda requires it
  "--no-zygote", // Lambda requires it
  "--single-process", // Lambda requires it
  "--disable-gpu",
  "--disable-extensions",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--no-pings",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-domain-reliability",
  "--disable-print-preview",
  "--disable-component-update",
  "--disable-breakpad",
  "--disable-webgl",
  "--font-render-hinting=none",
  "--proxy-server=direct://",
  "--proxy-bypass-list=<-loopback>",
  "--host-resolver-rules=MAP * ~NOTFOUND",
];

// A4 with the 12 mm margin of the template's @page rule (packages/core/invoices/render.ts).
export const PDF_OPTIONS = {
  format: "A4",
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
} as const;

// The smallest part of puppeteer that the renderer uses. Tests inject a fake of this shape.
export interface RequestLike {
  abort(errorCode?: string): Promise<void> | void;
}
export interface PageLike {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setBypassCSP(enabled: boolean): Promise<void>;
  setOfflineMode(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  setDefaultNavigationTimeout(ms: number): void;
  setDefaultTimeout(ms: number): void;
  on(event: "request", handler: (request: RequestLike) => void): unknown;
  setContent(html: string, options: { waitUntil: "load"; timeout: number }): Promise<void>;
  pdf(options: typeof PDF_OPTIONS): Promise<Uint8Array>;
}
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export type BrowserLauncher = () => Promise<BrowserLike>;

export interface PdfRendererDeps {
  readonly launch: BrowserLauncher;
  readonly fontsDir?: string;
  readonly fontOk?: (path: string) => Promise<boolean>;
  readonly timeoutMs?: number;
}

async function fileHasBytes(path: string): Promise<boolean> {
  try {
    await access(path);
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function closeQuietly(browser: BrowserLike | undefined): Promise<void> {
  if (browser === undefined) return;
  try {
    await browser.close();
  } catch {
    // a browser that cannot close dies with the container; nothing to report and nothing to leak
  }
}

const FIXED = new Set([ERR_ENGINE, ERR_FONT, ERR_TIMEOUT, ERR_RENDER]);

function fixedError(error: unknown): Error {
  return new Error(error instanceof Error && FIXED.has(error.message) ? error.message : ERR_RENDER);
}

export function createPdfRenderer(deps: PdfRendererDeps): PdfRenderer {
  const fontsDir = deps.fontsDir ?? FONTS_DIR;
  const fontOk = deps.fontOk ?? fileHasBytes;
  const timeoutMs = deps.timeoutMs ?? RENDER_TIMEOUT_MS;

  async function fontsPresent(locale: Locale): Promise<boolean> {
    if (locale !== "bn") return true;
    for (const file of BENGALI_FONT_FILES) {
      if (!(await fontOk(join(fontsDir, file)))) return false;
    }
    return true;
  }

  return {
    // One browser and one page per call, closed in the finally below: nothing is reused between renders.
    async render(html: string, opts: { locale: Locale }): Promise<Uint8Array> {
      // No Bengali font, no Bengali PDF: a page with empty boxes for letters is worse than no PDF.
      if (!(await fontsPresent(opts.locale))) throw new Error(ERR_FONT);

      let browser: BrowserLike | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = (async (): Promise<Uint8Array> => {
        try {
          browser = await deps.launch();
        } catch {
          throw new Error(ERR_ENGINE);
        }
        const page = await browser.newPage();
        // Order matters: scripts off and the network cut BEFORE the content exists.
        await page.setJavaScriptEnabled(false);
        await page.setBypassCSP(false);
        await page.setOfflineMode(true);
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          // Every request, whatever its scheme, is aborted.
          void Promise.resolve(request.abort("blockedbyclient")).catch(() => undefined);
        });
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
        await page.setContent(html, { waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS });
        return await page.pdf(PDF_OPTIONS);
      })();
      const clock = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(ERR_TIMEOUT)), timeoutMs);
      });
      try {
        return await Promise.race([work, clock]);
      } catch (error) {
        // Only fixed texts leave this function; the text of any other error is dropped on purpose (R14).
        throw fixedError(error);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // The browser is closed on success, on error and on timeout; the abandoned work then rejects and
        // is swallowed here so it cannot become an unhandled rejection.
        work.catch(() => undefined);
        await closeQuietly(browser);
      }
    },
  };
}

// The real launcher. The imports are dynamic, so building the handler loads neither puppeteer nor the
// Chromium package until the first render, and a unit test that never renders never loads them.
// @sparticuz/chromium stays outside the bundle (infra/stacks/workers.ts, nodejs.install).
async function launchChromium(): Promise<BrowserLike> {
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([
    import("puppeteer-core"),
    import("@sparticuz/chromium"),
  ]);
  chromium.setGraphicsMode = false;
  const browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: [...LAUNCH_ARGS],
    headless: "shell",
    // Puppeteer's own default arguments are not added; the fixed list above is the whole set.
    ignoreDefaultArgs: true,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: NAVIGATION_TIMEOUT_MS,
  });
  return browser as unknown as BrowserLike;
}

export function loadPdfRenderer(): PdfRenderer {
  return createPdfRenderer({ launch: launchChromium });
}

// ---- the store -------------------------------------------------------------------------------------

export interface S3CommandSender {
  send(command: unknown): Promise<unknown>;
}

// The shape invoicePdfKey of @tc/core produces: invoices/<customer uuid>/<invoice uuid>.<locale>.pdf
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INVOICE_KEY = new RegExp(`^invoices/${UUID_PART}/${UUID_PART}\\.(?:bn|en)\\.pdf$`);

export function createS3PdfStore(deps: {
  readonly client: S3CommandSender;
  readonly bucket: string;
}): PdfStore {
  if (deps.bucket.length === 0) throw new Error(ERR_BUCKET);
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      if (!INVOICE_KEY.test(key)) throw new Error(ERR_KEY);
      try {
        // Exactly one PutObject. No ServerSideEncryption field: the bucket's default encryption names the
        // customer-managed files key (infra/stacks/storage.ts), and a bare "aws:kms" here would pick the
        // AWS managed key instead. The role has s3:PutObject on invoices/* and kms:GenerateDataKey on
        // that key, and nothing else.
        await deps.client.send(
          new PutObjectCommand({
            Bucket: deps.bucket,
            Key: key,
            Body: bytes,
            ContentType: "application/pdf",
          }),
        );
      } catch {
        throw new Error(ERR_STORE);
      }
    },
  };
}

export function loadPdfStore(): PdfStore {
  const bucket = process.env["INVOICES_BUCKET"] ?? "";
  // The role of the function supplies the credentials (R3); no key is configured here.
  return createS3PdfStore({ bucket, client: new S3Client({}) as unknown as S3CommandSender });
}

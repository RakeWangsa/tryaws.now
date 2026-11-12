import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import {
  BENGALI_FONT_FILES,
  LAUNCH_ARGS,
  PDF_OPTIONS,
  createPdfRenderer,
  createS3PdfStore,
  loadPdfStore,
  type BrowserLike,
  type PageLike,
  type RequestLike,
} from "./engines";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "engines.ts"), "utf8");

const customerId = "0190a000-0000-7000-8000-000000000001";
const invoiceId = "0190a000-0000-7000-8000-000000000002";
const KEY = `invoices/${customerId}/${invoiceId}.en.pdf`;

interface Fake {
  calls: string[];
  aborted: string[];
  browser: BrowserLike;
  launches: () => number;
  launch: () => Promise<BrowserLike>;
  fire: (url: string) => void;
}

// A fake that records the order of the calls and answers a request the way puppeteer does: the handler
// registered with page.on("request") is the only thing that decides the fate of a request.
function fake(
  opts: { pdf?: () => Promise<Uint8Array>; setContent?: () => Promise<void> } = {},
): Fake {
  const calls: string[] = [];
  const aborted: string[] = [];
  let handler: ((r: RequestLike) => void) | undefined;
  let launched = 0;
  const page: PageLike = {
    setJavaScriptEnabled: async (v) => void calls.push(`js:${String(v)}`),
    setBypassCSP: async (v) => void calls.push(`csp:${String(v)}`),
    setOfflineMode: async (v) => void calls.push(`offline:${String(v)}`),
    setRequestInterception: async (v) => void calls.push(`intercept:${String(v)}`),
    setDefaultNavigationTimeout: () => void calls.push("navTimeout"),
    setDefaultTimeout: () => void calls.push("timeout"),
    on: (_event, h) => {
      calls.push("on:request");
      handler = h;
    },
    setContent: async () => {
      calls.push("setContent");
      await opts.setContent?.();
    },
    pdf: async (o) => {
      calls.push("pdf");
      expect(o).toBe(PDF_OPTIONS);
      return (await opts.pdf?.()) ?? new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    },
  };
  const browser: BrowserLike = {
    newPage: async () => page,
    close: async () => void calls.push("close"),
  };
  return {
    calls,
    aborted,
    browser,
    launches: () => launched,
    launch: async () => {
      launched += 1;
      calls.push("launch");
      return browser;
    },
    fire: (url) => {
      handler?.({ abort: (code) => void aborted.push(`${url}|${String(code)}`) });
    },
  };
}

const allFonts = async () => true;

describe("the pdf engine (WPU-D1)", () => {
  it("disables JavaScript, goes offline and intercepts requests before the content is set", async () => {
    const f = fake();
    const pdf = createPdfRenderer({ launch: f.launch, fontOk: allFonts });
    const bytes = await pdf.render("<p>x</p>", { locale: "en" });
    expect(bytes.length).toBeGreaterThan(0);
    const at = (c: string) => f.calls.indexOf(c);
    expect(at("js:false")).toBeGreaterThan(-1);
    expect(at("js:false")).toBeLessThan(at("setContent"));
    expect(at("offline:true")).toBeLessThan(at("setContent"));
    expect(at("intercept:true")).toBeLessThan(at("setContent"));
    expect(at("on:request")).toBeLessThan(at("setContent"));
    expect(at("csp:false")).toBeGreaterThan(-1);
    expect(at("js:false")).toBeLessThan(at("intercept:true"));
    expect(f.calls).not.toContain("js:true");
    expect(f.calls).not.toContain("intercept:false");
    expect(f.calls).not.toContain("offline:false");
  });

  it("aborts every request: an external URL, a data URL, a file URL and an about URL", async () => {
    const f = fake({
      setContent: async () => {
        f.fire("https://evil.example/steal?x=1");
        f.fire("data:text/css;base64,AAAA");
        f.fire("file:///etc/passwd");
        f.fire("about:blank");
        f.fire("http://169.254.169.254/latest/meta-data/");
      },
    });
    await createPdfRenderer({ launch: f.launch, fontOk: allFonts }).render("<p>x</p>", {
      locale: "en",
    });
    expect(f.aborted).toHaveLength(5);
    for (const entry of f.aborted) expect(entry.endsWith("|blockedbyclient")).toBe(true);
  });

  it("closes the browser on success, on a render error and on a launch that worked then failed", async () => {
    const ok = fake();
    await createPdfRenderer({ launch: ok.launch, fontOk: allFonts }).render("<p>x</p>", {
      locale: "en",
    });
    expect(ok.calls.filter((c) => c === "close")).toHaveLength(1);

    const bad = fake({
      pdf: async () => {
        throw new Error("secret detail <p>customer name</p>");
      },
    });
    await expect(
      createPdfRenderer({ launch: bad.launch, fontOk: allFonts }).render("<p>x</p>", {
        locale: "en",
      }),
    ).rejects.toThrow("invoice-renderer: render failed");
    expect(bad.calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("never leaks the text of an underlying error", async () => {
    const bad = fake({
      setContent: async () => {
        throw new Error("net::ERR at https://internal.example customer Rahim");
      },
    });
    const run = createPdfRenderer({ launch: bad.launch, fontOk: allFonts }).render("<p>x</p>", {
      locale: "en",
    });
    await expect(run).rejects.toThrow(/^invoice-renderer: render failed$/);
  });

  it("throws a fixed message when the render takes too long, and still closes the browser", async () => {
    const slow = fake({ pdf: () => new Promise<Uint8Array>(() => undefined) });
    const run = createPdfRenderer({ launch: slow.launch, fontOk: allFonts, timeoutMs: 20 }).render(
      "<p>x</p>",
      { locale: "en" },
    );
    await expect(run).rejects.toThrow("invoice-renderer: the render timed out");
    expect(slow.calls.filter((c) => c === "close")).toHaveLength(1);
  });

  it("throws a fixed message when the engine cannot start", async () => {
    const run = createPdfRenderer({
      launch: async () => {
        throw new Error("spawn /tmp/chromium ENOENT");
      },
      fontOk: allFonts,
    }).render("<p>x</p>", { locale: "en" });
    await expect(run).rejects.toThrow("invoice-renderer: the pdf engine is unavailable");
  });

  it("refuses a Bengali invoice when a Bengali font file is missing, and starts no browser", async () => {
    const f = fake();
    const present = new Set<string>([join("/fonts", BENGALI_FONT_FILES[0] ?? "")]);
    const pdf = createPdfRenderer({
      launch: f.launch,
      fontsDir: "/fonts",
      fontOk: async (p) => present.has(p),
    });
    await expect(pdf.render("<p>বাংলা</p>", { locale: "bn" })).rejects.toThrow(
      "invoice-renderer: the packaged font is missing",
    );
    expect(f.launches()).toBe(0);
    // the English invoice does not need the Bengali font
    await expect(
      createPdfRenderer({ launch: f.launch, fontsDir: "/fonts", fontOk: async () => false }).render(
        "<p>x</p>",
        { locale: "en" },
      ),
    ).resolves.toBeInstanceOf(Uint8Array);
  });

  it("renders a Bengali invoice when both font files are present", async () => {
    const f = fake();
    const seen: string[] = [];
    await createPdfRenderer({
      launch: f.launch,
      fontsDir: "/fonts",
      fontOk: async (p) => {
        seen.push(p);
        return true;
      },
    }).render("<p>বাংলা</p>", { locale: "bn" });
    expect(seen).toEqual(BENGALI_FONT_FILES.map((n) => join("/fonts", n)));
  });

  it("launches with a fixed hardened argument set that resolves no host and uses no proxy", () => {
    for (const arg of [
      "--disable-gpu",
      "--disable-extensions",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--disable-background-networking",
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--proxy-server=direct://",
    ]) {
      expect(LAUNCH_ARGS).toContain(arg);
    }
    for (const arg of LAUNCH_ARGS) {
      expect(arg).not.toMatch(/disable-web-security|allow-running-insecure|disable-site-isolation/);
      expect(arg).not.toMatch(/remote-debugging|remote-allow|user-data-dir/);
    }
    expect(PDF_OPTIONS.format).toBe("A4");
    expect(PDF_OPTIONS.printBackground).toBe(true);
  });

  it("has no way to hand the engine a customer-controlled argument or URL", () => {
    // the renderer's only inputs are the html string and the locale, both fixed by the handler
    expect(createPdfRenderer.length).toBe(1);
    expect(source).not.toMatch(/\bgoto\s*\(/);
    expect(source).not.toMatch(/page\.goto/);
    expect(source).not.toMatch(/setJavaScriptEnabled\(\s*true\s*\)/);
    expect(source).not.toMatch(/process\.env\[[^\]]*\]\s*[^;]*args/);
    // --no-sandbox appears only with the Lambda reason on the same line
    for (const line of source.split("\n")) {
      if (line.includes("--no-sandbox")) expect(line).toMatch(/Lambda/);
    }
    expect(source).toContain("IMPLEMENTED");
    expect(source).not.toContain("REQUIREMENT when it is wired");
  });
});

describe("the invoices store (WPU-D1)", () => {
  it("sends exactly one PutObject with the derived key, the pdf type and the bytes", async () => {
    const sent: unknown[] = [];
    const store = createS3PdfStore({
      bucket: "tc-invoices-test",
      client: { send: async (c) => void sent.push(c) },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    await store.put(KEY, bytes);
    expect(sent).toHaveLength(1);
    const command = sent[0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "tc-invoices-test",
      Key: KEY,
      Body: bytes,
      ContentType: "application/pdf",
    });
  });

  it("refuses a key that is not an invoice key and sends nothing", async () => {
    const sent: unknown[] = [];
    const store = createS3PdfStore({
      bucket: "tc-invoices-test",
      client: { send: async (c) => void sent.push(c) },
    });
    for (const key of [
      "kyc/x.pdf",
      `invoices/${customerId}/../${invoiceId}.en.pdf`,
      `invoices/${customerId}/${invoiceId}.fr.pdf`,
      `invoices/${customerId}/${invoiceId}.en.pdf/extra`,
      "",
    ]) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toThrow(
        "invoice-renderer: the object key is not an invoice key",
      );
    }
    expect(sent).toHaveLength(0);
  });

  it("throws a fixed message when S3 fails", async () => {
    const store = createS3PdfStore({
      bucket: "tc-invoices-test",
      client: {
        send: async () => {
          throw new Error("AccessDenied arn:aws:iam::123456789012:role/x");
        },
      },
    });
    await expect(store.put(KEY, new Uint8Array([1]))).rejects.toThrow(
      /^invoice-renderer: the store failed$/,
    );
  });

  it("fails closed without a bucket name", () => {
    const before = process.env["INVOICES_BUCKET"];
    delete process.env["INVOICES_BUCKET"];
    try {
      expect(() => loadPdfStore()).toThrow(
        "invoice-renderer: the invoices bucket is not configured",
      );
      expect(() =>
        createS3PdfStore({ bucket: "", client: { send: async () => undefined } }),
      ).toThrow("invoice-renderer: the invoices bucket is not configured");
    } finally {
      if (before !== undefined) process.env["INVOICES_BUCKET"] = before;
    }
  });

  it("uses no S3 command other than PutObject", () => {
    expect(source).toMatch(/new PutObjectCommand\(/);
    expect([...source.matchAll(/new (\w+Command)\(/g)].map((m) => m[1])).toEqual([
      "PutObjectCommand",
    ]);
  });
});

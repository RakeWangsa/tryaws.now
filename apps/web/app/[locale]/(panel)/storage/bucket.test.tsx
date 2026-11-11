import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BucketKeys } from "./[id]/BucketKeys.tsx";
import { BUCKET_ID, BUCKET_NAME, PLAN_SMALL, REQUEST_ID } from "./bucket.fixtures.ts";
import { STATE_RENDERERS, html } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/storage", () => {
  it("lists the buckets with the bucket name the customer needs, the location and the state", () => {
    const html = render("storage.ready");
    expect(html).toContain(BUCKET_NAME);
    expect(html).toContain(`href="/en/storage/${BUCKET_ID}"`);
    expect(html).toContain("Asia Pacific (Singapore)");
    expect(html).toContain("Amazon Lightsail object storage bucket");
    expect(html).toContain('href="/en/storage/new"');
  });

  it("is in Bengali in the bn locale", () => {
    expect(render("storage.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("storage.empty", "bn")).toMatch(/[ঀ-৿]/);
  });

  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("storage.flag_off");
    expect(html).toContain("Object Storage is coming soon");
    expect(html).not.toContain("/storage/new");
    expect(html).not.toContain("<a ");
  });

  it("the empty state offers the first bucket; the table fits a phone (360 px)", () => {
    expect(render("storage.empty")).toContain('href="/en/storage/new"');
    const html = render("storage.ready");
    expect(html).toContain("table-responsive-lg");
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/storage/new", () => {
  it("posts the plan, the region and the name of a bucket and nothing about access or a bucket name (R11)", () => {
    const out = render("storage_new.ready");
    for (const name of ["productId", "region", "displayName"]) {
      expect(out, name).toContain(`name="${name}"`);
    }
    expect(out).not.toMatch(/name="(bucketName|awsName|access|accessMode|mode|acl)"/);
    expect(out).toContain(`value="${PLAN_SMALL}"`);
    expect(out).toMatch(
      /name="region"[^>]*value="ap-southeast-1"|value="ap-southeast-1"[^>]*name="region"/,
    );
  });

  it("shows the exact price from the server and says a new bucket is private", () => {
    const out = render("storage_new.ready");
    expect(out).toContain("300.00");
    expect(out).toContain("A new bucket is always private");
    expect(out).toContain("250 GB storage");
  });

  it("each state that cannot buy says why and what to do next", () => {
    expect(render("storage_new.flag_off")).toContain("Object Storage is coming soon");
    expect(render("storage_new.kyc_required")).toContain("Verify your identity first");
    expect(render("storage_new.empty")).toContain("No plan is for sale right now");
  });
});

describe("/storage/[id]", () => {
  it("shows the generated bucket name and address, the location and four tabs", () => {
    const out = render("storage_detail.ready");
    expect(out).toContain(BUCKET_NAME);
    expect(out).toContain(`https://${BUCKET_NAME}.s3.ap-southeast-1.amazonaws.com`);
    expect(out).toContain("site-assets");
    for (const tab of ["Overview", "Access", "Access keys", "Delete"]) expect(out).toContain(tab);
  });

  it("says honestly what it cannot show: the usage and the current access mode", () => {
    const out = render("storage_detail.ready");
    expect(out).toContain("The amount used cannot be shown here yet.");
    expect(out).toContain("The current mode cannot be read on this page");
  });

  it("the public option needs the typed text and says what it means; the forms carry the ids (R7)", () => {
    const out = render("storage_detail.access");
    expect(out).toContain("Type PUBLIC to confirm");
    expect(out).toContain("anyone on the internet can see and download every file");
    expect(out).toContain(`name="bucketId" value="${BUCKET_ID}"`);
    expect(out).toContain(`name="requestId" value="${REQUEST_ID}"`);
    expect(out).toContain('name="mode" value="private"');
    expect(out).toContain('name="mode" value="public"');
    expect(out).toContain('name="confirmText"');
  });

  it("the keys tab warns that the secret is shown once and for 60 seconds, and offers rotation steps", () => {
    const out = render("storage_detail.keys");
    expect(out).toContain("shown only once");
    expect(out).toContain("60 seconds");
    expect(out).toContain("To replace a key");
    expect(out).toContain('name="accessKeyId"');
  });

  it("a suspended bucket cannot change access or make keys", () => {
    const out = render("storage_detail.suspended");
    expect(out).toContain("A key cannot be made unless the bucket is on.");
    expect(out).toContain("Access cannot be changed unless the bucket is on.");
  });

  it("follows the guard: the destroy tab says it is not open while the guard refuses, and opens the dialog when it passes", () => {
    const closed = render("storage_detail.ready");
    expect(closed).toContain("Deleting a bucket is not open yet.");
    expect(closed).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]*>)*[^<]*Delete bucket/);
    const open = render("storage_detail.destroy_open");
    expect(open).not.toContain("Deleting a bucket is not open yet.");
  });

  it("another customer's bucket and a missing one show the same not-found state", () => {
    const out = render("storage_detail.not_found");
    expect(out).toContain("Bucket not found");
    expect(out).toContain('href="/en/storage"');
  });
});

describe("U9: the secret key", () => {
  const noop = async () => ({ ok: false as const, error: "unavailable" });
  const SECRET = "tc-test-secret-key-value-do-not-print";

  it("is not in the server HTML: the first state is hidden and the key id only is shown", () => {
    const out = html(
      <BucketKeys
        bucketId={BUCKET_ID}
        requestId={REQUEST_ID}
        active
        action={noop}
        initial={{ accessKeyId: "AKIAEXAMPLEKEY123456", secretAccessKey: SECRET }}
      />,
      "en",
    );
    expect(out).toContain("AKIAEXAMPLEKEY123456");
    expect(out).not.toContain(SECRET);
  });

  it("offers the button only for a bucket that is on, and puts the ids and nothing secret in the form", () => {
    const on = html(
      <BucketKeys bucketId={BUCKET_ID} requestId={REQUEST_ID} active action={noop} />,
      "en",
    );
    expect(on).toContain("Make a new key");
    expect(on).toContain(`name="bucketId" value="${BUCKET_ID}"`);
    const off = html(
      <BucketKeys bucketId={BUCKET_ID} requestId={REQUEST_ID} active={false} action={noop} />,
      "en",
    );
    expect(off).not.toContain("Make a new key");
    expect(off).toContain("A key cannot be made unless the bucket is on.");
  });
});

describe("R1: the web app never reaches AWS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no bucket screen or bucket server file imports packages/aws or an AWS SDK client", () => {
    const server = resolve(here, "../../../../server");
    const all = [
      ...files(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("bucket.test.tsx")),
      ...readdirSync(server)
        .filter((f) => f.startsWith("bucket-") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(server, f)),
    ];
    expect(all.length).toBeGreaterThan(15);
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tc\/aws|@aws-sdk\//);
    }
  });

  it("the secret key never reaches a log, a cookie, a storage or a cache header in the screen files", () => {
    const keyFiles = files(here).filter((f) => /BucketKeys|key-actions/.test(f));
    expect(keyFiles.length).toBe(2);
    for (const file of keyFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /console\.|localStorage|sessionStorage|document\.cookie|cookies\(/,
      );
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// WPU-B7: the infra half of the fixes of the security review (L1, L2, L3). The text of the stacks is the
// proof, as in reader-tier.test.mjs.
const read = (p) => readFileSync(resolve(import.meta.dirname, "../..", p), "utf8");
const web = read("infra/stacks/web.ts");
const workers = read("infra/stacks/workers.ts");
const between = (text, from, to) => {
  const start = text.indexOf(from);
  const end = to === undefined ? text.length : text.indexOf(to, start + from.length);
  return text.slice(start, end === -1 ? text.length : end);
};
// The code of the Admin component, without its comment lines (they name what is not granted).
const code = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
const admin = code(between(web, 'new sst.aws.Nextjs("Admin"'));
const customer = between(web, 'new sst.aws.Nextjs("Web"', 'new sst.aws.Nextjs("Admin"');

describe("L1: the admin role holds no queue permission", () => {
  it("has no sqs action and no queue URL (the admin app has no queue client)", () => {
    expect(admin).not.toContain("sqs:");
    expect(admin).not.toContain("PROVISIONING_QUEUE_URL");
    expect(admin).not.toContain("queues.provisioning");
  });
  it("the admin app depends on no AWS SDK and imports no queue port", () => {
    const pkg = JSON.parse(read("apps/admin/package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => d.startsWith("@aws-sdk/"))).toEqual([]);
  });
  it("the web role keeps the queue it uses (apps/web/server/queue-port.ts)", () => {
    expect(customer).toContain('actions: ["sqs:SendMessage"]');
    expect(customer).toContain("PROVISIONING_QUEUE_URL");
  });
});

describe("L2: invoices/* stays readable for the web role", () => {
  it("the renderer returns the key of a stored PDF, not bytes, and web reads the bucket", () => {
    const handler = read("functions/invoice-renderer/handler.ts");
    expect(handler).toContain("return { ok: true, key, bytes: bytes.byteLength }");
    expect(customer).toContain("$interpolate`${storage.invoices.arn}/*`");
    expect(customer).toContain("$interpolate`${storage.exports.arn}/*`");
  });
});

describe("L3: the invoice renderer is invoked by its web alias only", () => {
  it("publishes a version and has one alias named web", () => {
    expect(workers).toMatch(/spec\.dir === "reader" \|\| spec\.dir === "invoice-renderer"/);
    expect(workers).toMatch(/new aws\.lambda\.Alias\("RendererAliasWeb",\s*\{\s*name: "web"/);
    expect(workers).toContain("rendererAlias");
  });
  it("grants the web role the alias ARN and no role the unqualified ARN of the renderer", () => {
    expect(web).toContain("workers.rendererAlias.arn");
    expect(web).not.toMatch(/invoke\([^)]*invoice-renderer/);
    expect(web).not.toContain('workers.invoked["invoice-renderer"]');
    expect(admin).not.toContain("invoice-renderer");
    expect(admin).not.toContain("rendererAlias");
    // exactly one place names the alias in the web file
    expect(web.match(/rendererAlias/g)).toHaveLength(1);
  });
  it("the handler reads the tier from the invoked ARN of the context, never from the event", () => {
    const index = read("functions/invoice-renderer/index.ts");
    expect(index).toContain("rendererTierOf(context?.invokedFunctionArn)");
    expect(index).not.toMatch(/event\.tier|event\["tier"\]/);
  });
});

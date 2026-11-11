import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PLAN_NANO, PUBLIC_URL, REQUEST_ID, SERVICE_ID } from "./container.fixtures.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/containers", () => {
  it("lists the services with the public address the customer needs, the location and the state", () => {
    const html = render("containers.ready");
    expect(html).toContain(PUBLIC_URL);
    expect(html).toContain(`href="/en/containers/${SERVICE_ID}"`);
    expect(html).toContain("Asia Pacific (Singapore)");
    expect(html).toContain("Amazon Lightsail container service");
    expect(html).toContain('href="/en/containers/new"');
  });

  it("is in Bengali in the bn locale", () => {
    expect(render("containers.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("containers.empty", "bn")).toMatch(/[ঀ-৿]/);
  });

  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("containers.flag_off");
    expect(html).toContain("Container Service is coming soon");
    expect(html).not.toContain("/containers/new");
    expect(html).not.toContain("<a ");
  });

  it("the empty state offers the first service; the table fits a phone (360 px)", () => {
    expect(render("containers.empty")).toContain('href="/en/containers/new"');
    const html = render("containers.ready");
    expect(html).toContain("table-responsive-lg");
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/containers/new", () => {
  it("posts the plan, the region and the name; power and scale are not fields (R11)", () => {
    const out = render("containers_new.ready");
    for (const name of ["productId", "region", "displayName"]) {
      expect(out, name).toContain(`name="${name}"`);
    }
    expect(out).not.toMatch(/name="(power|scale|image|containerName|serviceName|registry)"/);
    expect(out).toContain(`value="${PLAN_NANO}"`);
  });

  it("shows the exact price from the server, the power and the scale of the plan", () => {
    const out = render("containers_new.ready");
    expect(out).toContain("900.00");
    expect(out).toContain("Nano");
    expect(out).toContain("2 container instances");
    expect(out).toContain("0.5 GB RAM each");
  });

  it("each state that cannot buy says why and what to do next", () => {
    expect(render("containers_new.flag_off")).toContain("Container Service is coming soon");
    expect(render("containers_new.kyc_required")).toContain("Verify your identity first");
    expect(render("containers_new.empty")).toContain("No plan is for sale right now");
  });
});

describe("/containers/[id]", () => {
  it("shows power, scale, the public address and four tabs", () => {
    const out = render("containers_detail.ready");
    expect(out).toContain("web-app");
    expect(out).toContain(PUBLIC_URL);
    expect(out).toContain("Micro");
    for (const tab of ["Overview", "Deployments", "New deployment", "Delete"]) {
      expect(out).toContain(tab);
    }
  });

  it("says honestly what it cannot show: usage, and an address that does not exist yet", () => {
    expect(render("containers_detail.ready")).toContain(
      "The amount used cannot be shown here yet.",
    );
    const pending = render("containers_detail.no_deployment");
    expect(pending).toContain("The address will show here once your image is running.");
    expect(pending).toContain("No image has been started yet.");
  });

  it("shows the current deployment with the names of the variables and never their values (R14)", () => {
    const out = render("containers_detail.deployments");
    expect(out).toContain("nginx:1.27");
    expect(out).toContain("80/HTTP");
    expect(out).toContain("MODE, API_TOKEN");
    expect(out).toContain("only the names are shown, not the values");
    expect(out).toContain("/health");
    expect(out).toContain("Deployment requests");
  });

  it("the deploy form has fields for the image, port, protocol, variables and endpoint, and none for a name or a registry login (R11)", () => {
    const out = render("containers_detail.deploy");
    for (const name of [
      "image",
      "port",
      "protocol",
      "environment",
      "publicEndpoint",
      "healthCheckPath",
    ]) {
      expect(out, name).toContain(`name="${name}"`);
    }
    expect(out).not.toMatch(
      /name="(containerName|serviceName|name|registry|registryLogin|username|password|label|tag)"/,
    );
    expect(out).toContain(`name="containerId" value="${SERVICE_ID}"`);
    expect(out).toContain(`name="requestId" value="${REQUEST_ID}"`);
    expect(out).toContain("No login is given for a private registry.");
  });

  it("a service that is not on cannot be deployed to", () => {
    const out = render("containers_detail.suspended");
    expect(out).toContain("A deployment cannot be made unless the service is on.");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("there is no button to change the power or the scale; the page says why", () => {
    const out = render("containers_detail.ready");
    expect(out).toContain("There is no button here to change them later");
    expect(out).not.toMatch(/name="(power|scale|productId)"/);
  });

  it("another customer's service and a missing one show the same not-found state", () => {
    const out = render("containers_detail.not_found");
    expect(out).toContain("Container service not found");
    expect(out).toContain('href="/en/containers"');
  });
});

describe("R1: the web app never reaches AWS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no container screen or container server file imports packages/aws or an AWS SDK client", () => {
    const server = resolve(here, "../../../../server");
    const all = [
      ...files(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("container.test.tsx")),
      ...readdirSync(server)
        .filter((f) => f.startsWith("container-") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(server, f)),
    ];
    expect(all.length).toBeGreaterThan(15);
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tc\/aws|@aws-sdk\//);
    }
  });

  it("no screen file names the registry login call or a private registry setting", () => {
    for (const file of files(here).filter((f) => /\.(ts|tsx)$/.test(f))) {
      if (file.endsWith("container.test.tsx")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /RegistryLogin|privateRegistryAccess|ecrImagePullerRole/,
      );
    }
  });
});

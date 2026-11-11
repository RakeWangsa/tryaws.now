import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  LB_ID,
  PLAN,
  REQUEST_ID,
  SERVER_1,
  SERVER_2,
  SERVER_FAR,
} from "./load-balancers.fixtures.ts";
import { STATE_RENDERERS } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/load-balancers", () => {
  it("lists the load balancers with the location, the number of servers and the state", () => {
    const html = render("lb.ready");
    expect(html).toContain(`href="/en/load-balancers/${LB_ID}"`);
    expect(html).toContain("front");
    expect(html).toContain("Singapore");
    expect(html).toContain("Amazon Lightsail load balancer");
    expect(html).toContain('href="/en/load-balancers/new"');
  });

  it("is in Bengali in the bn locale", () => {
    expect(render("lb.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("lb.empty", "bn")).toMatch(/[ঀ-৿]/);
  });

  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("lb.flag_off");
    expect(html).toContain("Load Balancers are coming soon");
    expect(html).not.toContain("/load-balancers/new");
    expect(html).not.toContain("<a ");
  });

  it("the empty state offers the first balancer; the table fits a phone (360 px)", () => {
    expect(render("lb.empty")).toContain('href="/en/load-balancers/new"');
    const html = render("lb.ready");
    expect(html).toContain("table-responsive-lg");
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/load-balancers/new", () => {
  it("posts the plan, the Region, the name and the targets, and nothing about a certificate or an AWS name (R11)", () => {
    const html = render("lb_new.ready");
    for (const name of ["productId", "region", "displayName", "targetIds"]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).not.toMatch(/name="(certificate|certificateName|domain|awsName|healthCheckPath)"/);
    expect(html).toContain(`value="${PLAN}"`);
  });

  it("offers only the customer's own servers of the first Region as targets (R8)", () => {
    const html = render("lb_new.ready");
    expect(html).toContain(`value="${SERVER_1}"`);
    expect(html).toContain(`value="${SERVER_2}"`);
    expect(html).toContain("web-1");
    // The server in Mumbai is another Region than the first plan's Region: not a target here.
    expect(html).not.toContain(`value="${SERVER_FAR}"`);
    expect(html).not.toContain("mumbai-1");
  });

  it("shows the exact price from the server and says HTTPS is not available yet", () => {
    const html = render("lb_new.ready");
    expect(html).toContain("1,800.00");
    expect(html).toContain("HTTPS certificate cannot be added yet");
  });

  it("each state that cannot buy says why and what to do next", () => {
    expect(render("lb_new.flag_off")).toContain("Load Balancers are coming soon");
    expect(render("lb_new.kyc_required")).toContain("Verify your identity first");
    expect(render("lb_new.empty")).toContain("No plan is for sale right now");
    const noServers = render("lb_new.no_servers");
    expect(noServers).toContain("No server to use as a target");
    expect(noServers).toContain('href="/en/servers"');
  });
});

describe("/load-balancers/[id]", () => {
  it("shows the location, the targets by name and the four tabs", () => {
    const html = render("lb_detail.ready");
    expect(html).toContain("front");
    expect(html).toContain("web-1");
    for (const tab of ["Overview", "Target servers", "Health and HTTPS", "Delete"]) {
      expect(html).toContain(tab);
    }
  });

  it("a target that is gone is shown as gone, with no name of another customer's server", () => {
    const html = render("lb_detail.ready");
    expect(html).toContain("The server no longer exists");
  });

  it("health and the certificate are honest 'not available' states, with nothing to click", () => {
    const html = render("lb_detail.ready");
    expect(html).toContain("Health cannot be shown now");
    expect(html).toContain("Adding an HTTPS certificate is not available yet");
    expect(html).not.toMatch(/name="(certificate|certificateName|domain)"/);
  });

  it("without a wired action the targets tab says changing is not available yet; with one it offers the servers of the Region", () => {
    expect(render("lb_detail.ready")).toContain("Changing the target servers is not available yet");
    expect(render("lb_detail.ready")).not.toContain('name="targetIds"');
    const form = render("lb_detail.targets_form");
    expect(form).toContain('name="targetIds"');
    expect(form).toContain(`value="${SERVER_1}"`);
    expect(form).toContain(`value="${SERVER_2}"`);
    expect(form).toContain(`name="loadBalancerId" value="${LB_ID}"`);
    expect(form).toContain(`name="requestId" value="${REQUEST_ID}"`);
    expect(form).not.toContain(`value="${SERVER_FAR}"`);
  });

  it("the delete tab names the typed-name dialog and says there is no snapshot; another customer's balancer shows the not-found state", () => {
    expect(render("lb_detail.ready")).toContain("A load balancer has no snapshot");
    const html = render("lb_detail.not_found");
    expect(html).toContain("Load balancer not found");
    expect(html).toContain('href="/en/load-balancers"');
  });
});

describe("R1: the web app never reaches AWS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no load balancer screen or server file imports packages/aws or an AWS SDK client", () => {
    const server = resolve(here, "../../../../server");
    const all = [
      ...files(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("load-balancers.test.tsx")),
      ...readdirSync(server)
        .filter((f) => /^load-balancers-/.test(f) && f.endsWith(".ts") && !f.endsWith(".test.ts"))
        .map((f) => join(server, f)),
    ];
    expect(all.length).toBeGreaterThan(14);
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tc\/aws|@aws-sdk\//);
    }
  });
});

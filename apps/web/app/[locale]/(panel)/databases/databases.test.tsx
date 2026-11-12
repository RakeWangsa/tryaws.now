import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_ID, ENDPOINT, PLAN_SMALL, REQUEST_ID } from "./databases.fixtures.ts";
import { STATE_RENDERERS, TEST_SECRET } from "./mockup-states.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const render = (id: string, locale: "bn" | "en" = "en"): string =>
  (STATE_RENDERERS[id] as (l: "bn" | "en") => string)(locale);

describe("/databases", () => {
  it("lists the databases with engine, location, the endpoint the customer needs, and the state", () => {
    const html = render("databases.ready");
    expect(html).toContain(`${ENDPOINT}:3306`);
    expect(html).toContain(`href="/en/databases/${DATABASE_ID}"`);
    expect(html).toContain("MySQL 8.0");
    expect(html).toContain("PostgreSQL 16");
    expect(html).toContain("Singapore");
    expect(html).toContain("Amazon Lightsail managed database");
    expect(html).toContain('href="/en/databases/new"');
  });

  it("is in Bengali in the bn locale", () => {
    expect(render("databases.ready", "bn")).toMatch(/[ঀ-৿]/);
    expect(render("databases.empty", "bn")).toMatch(/[ঀ-৿]/);
  });

  it("the flag-off state says soon and offers nothing that could buy (R12)", () => {
    const html = render("databases.flag_off");
    expect(html).toContain("Databases are coming soon");
    expect(html).not.toContain("/databases/new");
    expect(html).not.toContain("<a ");
  });

  it("the empty state offers the first database; the table fits a phone (360 px)", () => {
    expect(render("databases.empty")).toContain('href="/en/databases/new"');
    const html = render("databases.ready");
    expect(html).toContain("table-responsive-lg");
    expect(html).not.toMatch(/style="[^"]*width:\s*\d+px/);
  });
});

describe("/databases/new", () => {
  it("posts the plan, the Region and the name, and nothing about a password or public access (R11, U9)", () => {
    const html = render("databases_new.ready");
    for (const name of ["productId", "region", "displayName"]) {
      expect(html, name).toContain(`name="${name}"`);
    }
    expect(html).not.toMatch(
      /name="(password|masterPassword|publiclyAccessible|public|engine|version|blueprint)"/,
    );
    expect(html).toContain(`value="${PLAN_SMALL}"`);
  });

  it("shows the exact price from the server and the engine, version and sizes of the plan", () => {
    const html = render("databases_new.ready");
    expect(html).toContain("2,500.00");
    expect(html).toContain("MySQL 8.0");
    expect(html).toContain("Private");
  });

  it("each state that cannot buy says why and what to do next", () => {
    expect(render("databases_new.flag_off")).toContain("Databases are coming soon");
    expect(render("databases_new.kyc_required")).toContain("Verify your identity first");
    expect(render("databases_new.empty")).toContain("No plan is for sale right now");
  });
});

describe("/databases/[id]", () => {
  it("shows the endpoint and the port the customer needs, and the six tabs", () => {
    const html = render("databases_detail.ready");
    expect(html).toContain("main-db");
    expect(html).toContain(ENDPOINT);
    expect(html).toContain("3306");
    expect(html).toContain("MySQL 8.0");
    for (const tab of ["Overview", "Connect", "Backups", "Metrics", "Settings", "Delete"]) {
      expect(html).toContain(tab);
    }
  });

  it("never carries a password: only a button to ask for it, and the rules of U9 (once, 60 seconds)", () => {
    const html = render("databases_detail.ready");
    expect(html).toContain("Show password");
    expect(html).toContain("shown once, removed after 60 seconds");
    expect(html).not.toContain(TEST_SECRET.password);
    expect(html).not.toMatch(/name="(password|masterPassword)"/);
  });

  it("shows the password only in the one state that follows the button, and hides the button then", () => {
    const html = render("databases_detail.secret");
    expect(html).toContain(TEST_SECRET.username);
    expect(html).not.toContain("Show password");
  });

  it("says that public access is off and cannot be switched yet, with a warning", () => {
    const html = render("databases_detail.ready");
    expect(html).toContain("This database is private");
    expect(html).toContain("anyone on the internet could try to connect");
    expect(html).toContain("Switching public access on or off is not available yet");
    expect(html).not.toMatch(/name="(public|publicMode|publiclyAccessible)"/);
  });

  it("lists the backups, offers none to take yet, and says metrics are not available", () => {
    const html = render("databases_detail.ready");
    expect(html).toContain("main-db final");
    expect(html).toContain("Final backup");
    expect(html).toContain("Taking a backup yourself is not available yet");
    expect(html).toContain("Metrics cannot be shown now");
  });

  it("the switch form carries the id, the request id (R7) and the next state; a stopped one offers start", () => {
    const on = render("databases_detail.ready");
    expect(on).toContain(`name="databaseId" value="${DATABASE_ID}"`);
    expect(on).toContain(`name="requestId" value="${REQUEST_ID}"`);
    expect(on).toContain('name="run" value="stop"');
    const off = render("databases_detail.stopped");
    expect(off).toContain('name="run" value="start"');
    expect(off).toContain("Start");
  });

  it("a database that is still being created has no endpoint yet and no switch", () => {
    const html = render("databases_detail.pending_endpoint");
    expect(html).toContain("The endpoint will show here once the database is created.");
    expect(html).toContain("cannot be started or stopped in this state");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
    expect(html).toContain("The password can be shown only while the database is running.");
  });

  it("the delete tab names the final backup, and another customer's database shows the not-found state", () => {
    expect(render("databases_detail.ready")).toContain("A final backup is taken first");
    const html = render("databases_detail.not_found");
    expect(html).toContain("Database not found");
    expect(html).toContain('href="/en/databases"');
  });
});

describe("R1: the web app never reaches AWS", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });

  it("no database screen or database server file imports packages/aws or an AWS SDK client", () => {
    const server = resolve(here, "../../../../server");
    const all = [
      ...files(here).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("databases.test.tsx")),
      ...readdirSync(server)
        .filter(
          (f) => /^(databases-|family-)/.test(f) && f.endsWith(".ts") && !f.endsWith(".test.ts"),
        )
        .map((f) => join(server, f)),
    ];
    expect(all.length).toBeGreaterThan(15);
    for (const file of all) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@tc\/aws|@aws-sdk\//);
    }
  });
});

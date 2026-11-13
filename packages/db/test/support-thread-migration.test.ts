import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "../migrate";
import {
  CASE_STATUSES,
  SUPPORT_AUTHOR_TYPES,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_STATUSES,
  supportMessages,
  supportRequests,
} from "../schema/service";

// WPU-Z5 (owner decision 2026-11-13, round 3): support requests have a thread. Migration 0027 is checked
// here without a database: its statements, its grants against grants.expected.json, and the journal and
// snapshot chain. The same migration is proven against PostgreSQL by roles.test.ts (the whole grant
// matrix), service.test.ts (columns and checks) and support-thread.test.ts.

const TAG = "0027_support_thread";
const read = (name: string): string => readFileSync(`${MIGRATIONS_FOLDER}/${name}`, "utf8");
const sql = (): string => read(`${TAG}.sql`);
// The statements without the comment lines, on one line each.
const statements = (text: string): string[] =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*(?:-->\s*statement-breakpoint)?/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");

type Cell = {
  table: string[];
  selectColumns: string[] | null;
  insertColumns: string[] | null;
  updateColumns: string[] | null;
};
const ROLES = ["web_rw", "admin_rw", "worker_rw", "report_ro"] as const;
const GRANT = /^GRANT ([A-Z, ]+?)(?: \(([a-z_, ]+)\))? ON ([a-z_]+) TO ([a-z_, ]+)$/;

// The grants of one table, as the cells of grants.expected.json, from the GRANT statements of the files.
function cellsFrom(files: readonly string[], table: string): Record<string, Cell> {
  const cells: Record<string, Cell> = {};
  for (const role of ROLES) {
    cells[role] = { table: [], selectColumns: null, insertColumns: null, updateColumns: null };
  }
  for (const file of files) {
    for (const s of statements(read(file)).filter((x) => x.startsWith("GRANT "))) {
      const m = GRANT.exec(s);
      if (m === null || m[3] !== table) continue;
      const privileges = (m[1] as string).split(",").map((p) => p.trim());
      const columns = m[2]?.split(",").map((c) => c.trim());
      for (const role of (m[4] as string).split(",").map((r) => r.trim())) {
        const cell = cells[role];
        if (cell === undefined) throw new Error(`a grant to ${role} on ${table}`);
        for (const privilege of privileges) {
          if (columns === undefined) cell.table.push(privilege);
          else {
            const key = `${privilege.toLowerCase()}Columns` as
              "selectColumns" | "insertColumns" | "updateColumns";
            cell[key] = [...(cell[key] ?? []), ...columns];
          }
        }
      }
    }
  }
  return cells;
}
const sorted = (cells: Record<string, Cell>): Record<string, Cell> =>
  Object.fromEntries(
    Object.entries(cells).map(([role, c]) => [
      role,
      {
        table: [...c.table].sort(),
        selectColumns: c.selectColumns === null ? null : [...c.selectColumns].sort(),
        insertColumns: c.insertColumns === null ? null : [...c.insertColumns].sort(),
        updateColumns: c.updateColumns === null ? null : [...c.updateColumns].sort(),
      },
    ]),
  );

describe("migration 0027: the support thread", () => {
  // WPU-Z19: 0028 follows it, so 0027 is no longer the last entry; it is still the one right after 0026.
  it("exists in the journal right after 0026, with a newer time", () => {
    expect(existsSync(`${MIGRATIONS_FOLDER}/${TAG}.sql`)).toBe(true);
    const journal = JSON.parse(read("meta/_journal.json")) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const at = journal.entries.findIndex((e) => e.tag === TAG);
    const last = journal.entries[at];
    const before = journal.entries[at - 1];
    expect(last?.tag).toBe(TAG);
    expect(before?.tag).toBe("0026_sale_snapshot_required");
    expect(last?.idx).toBe((before?.idx ?? -2) + 1);
    expect(last?.when).toBeGreaterThan(before?.when ?? Number.POSITIVE_INFINITY);
  });

  it("its snapshot is the child of 0026 and holds the new table, the new column and the new check", () => {
    const parent = JSON.parse(read("meta/0026_snapshot.json")) as { id: string };
    const child = JSON.parse(read("meta/0027_snapshot.json")) as {
      id: string;
      prevId: string;
      tables: Record<string, { columns: Record<string, unknown>; checkConstraints: object }>;
    };
    expect(child.prevId).toBe(parent.id);
    expect(child.id).not.toBe(parent.id);
    const messages = child.tables["public.support_messages"];
    expect(Object.keys(messages?.columns ?? {}).sort()).toEqual(
      ["admin_id", "author_type", "body", "created_at", "id", "request_id"].sort(),
    );
    const requests = child.tables["public.support_requests"];
    expect(requests?.columns).toHaveProperty("last_activity_at");
    expect(JSON.stringify(requests?.checkConstraints)).toContain("'open', 'answered', 'closed'");
  });

  it("creates support_messages with its checks, foreign keys and the (request_id, created_at) index", () => {
    const all = statements(sql()).join("\n");
    expect(all).toMatch(/CREATE TABLE "support_messages"/);
    expect(all).toContain(`"author_type" in ('customer', 'visitor', 'admin')`);
    expect(all).toContain(
      `("support_messages"."author_type" = 'admin') = ("support_messages"."admin_id" IS NOT NULL)`,
    );
    expect(all).toContain(`char_length("support_messages"."body") between 1 and 5000`);
    expect(all).toContain(
      `FOREIGN KEY ("request_id") REFERENCES "public"."support_requests"("id")`,
    );
    expect(all).toContain(`FOREIGN KEY ("admin_id") REFERENCES "public"."admin_users"("id")`);
    expect(all).toContain(
      `CREATE INDEX "support_messages_request_id_created_at_idx" ON "support_messages" USING btree ("request_id","created_at")`,
    );
  });

  it("replaces the named status check of support_requests and adds last_activity_at, set from created_at", () => {
    const list = statements(sql());
    const drop = list.indexOf(
      `ALTER TABLE "support_requests" DROP CONSTRAINT "support_requests_status_check"`,
    );
    const add = list.indexOf(
      `ALTER TABLE "support_requests" ADD CONSTRAINT "support_requests_status_check" CHECK ("support_requests"."status" in ('open', 'answered', 'closed'))`,
    );
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(add).toBeGreaterThan(drop);
    expect(list).toContain(
      `ALTER TABLE "support_requests" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL`,
    );
    expect(list).toContain(`UPDATE "support_requests" SET "last_activity_at" = "created_at"`);
    // forward-only and nothing else of the table: no column is dropped, no row is deleted
    expect(list.join("\n")).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM|TRUNCATE/i);
  });

  it("grants least privilege: web_rw and admin_rw only, by column, nothing wholesale", () => {
    const grants = statements(sql()).filter((s) => /^(GRANT|REVOKE)\b/.test(s));
    expect(grants.sort()).toEqual(
      [
        "GRANT SELECT (id, request_id, author_type, body, created_at) ON support_messages TO web_rw",
        "GRANT INSERT (id, request_id, author_type, body) ON support_messages TO web_rw",
        "GRANT SELECT (last_activity_at) ON support_requests TO web_rw",
        "GRANT UPDATE (status, last_activity_at) ON support_requests TO web_rw",
        "GRANT SELECT ON support_messages TO admin_rw",
        "GRANT INSERT (id, request_id, author_type, admin_id, body) ON support_messages TO admin_rw",
        "GRANT UPDATE (last_activity_at) ON support_requests TO admin_rw",
      ].sort(),
    );
    expect(grants.join("\n")).not.toMatch(
      /worker_rw|report_ro|PUBLIC|migrator|\bALL\b|GRANT OPTION|DELETE|TRUNCATE/,
    );
  });

  it("grants.expected.json holds exactly the grants of 0006 and 0027 for the two support tables", () => {
    const expected = JSON.parse(
      readFileSync(new URL("./grants.expected.json", import.meta.url), "utf8"),
    ) as Record<string, Record<string, Cell>>;
    const files = ["0006_roles_and_grants.sql", `${TAG}.sql`];
    for (const table of ["support_requests", "support_messages"]) {
      expect(sorted(expected[table] ?? {}), table).toEqual(sorted(cellsFrom(files, table)));
    }
    // web_rw never reads the admin of a message; nobody but admin_rw names one
    expect(expected.support_messages?.web_rw?.selectColumns).not.toContain("admin_id");
    expect(expected.support_messages?.web_rw?.insertColumns).not.toContain("admin_id");
  });
});

describe("the drizzle schema of the thread", () => {
  it("support requests are open, answered or closed; abuse cases keep open and closed", () => {
    expect(SUPPORT_STATUSES).toEqual(["open", "answered", "closed"]);
    expect(CASE_STATUSES).toEqual(["open", "closed"]);
    expect(SUPPORT_AUTHOR_TYPES).toEqual(["customer", "visitor", "admin"]);
    expect(SUPPORT_MESSAGE_MAX).toBe(5000);
  });

  it("support_messages and support_requests.last_activity_at are declared", () => {
    expect(supportMessages.requestId.name).toBe("request_id");
    expect(supportMessages.adminId.name).toBe("admin_id");
    expect(supportMessages.body.notNull).toBe(true);
    expect(supportRequests.lastActivityAt.name).toBe("last_activity_at");
    expect(supportRequests.lastActivityAt.notNull).toBe(true);
  });
});

import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, insertRow } from "./sql";
import { newAdmin, newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { columnTests } from "./expected-columns";

const t = useTempDatabase();
columnTests(
  () => t.pool,
  [
    "domains",
    "dns_zones",
    "notifications",
    "waitlist_entries",
    "support_requests",
    "support_messages",
    "abuse_cases",
    "discrepancies",
    "audit_log",
  ],
);

it.each(["notifications", "waitlist_entries", "support_requests"])(
  "%s needs a customer or an email",
  async (table) => {
    const rows: Record<string, Record<string, unknown>> = {
      notifications: { channel: "email", template: "welcome", dedupe_key: uniqueSuffix() },
      waitlist_entries: {
        product_family: "windows_instance",
        region: "ap-south-1",
        reason: "flag_off",
      },
      support_requests: { category: "billing", subject: "s", message: "m" },
    };
    await expectSqlError(insertRow(t.pool, table, rows[table]!), "23514", {
      constraint: `${table}_recipient_check`,
    });
    await insertRow(t.pool, table, { ...rows[table]!, email: "visitor@example.test" });
  },
);

it("notifications: three channels, a unique dedupe key, pending at first", async () => {
  const customer_id = await newCustomer(t.pool);
  const id = await insertRow(t.pool, "notifications", {
    customer_id,
    channel: "in_app",
    template: "renewal_reminder",
    dedupe_key: "sub-1:2026-12-11:7",
  });
  expect(
    (await t.pool.query("select status, attempts, payload from notifications where id = $1", [id]))
      .rows[0],
  ).toEqual({ status: "pending", attempts: 0, payload: {} });
  await expectSqlError(
    insertRow(t.pool, "notifications", {
      customer_id,
      channel: "sms",
      template: "x",
      dedupe_key: "sub-1:2026-12-11:7",
    }),
    "23505",
    { constraint: "notifications_dedupe_key_unique" },
  );
  await expectSqlError(
    insertRow(t.pool, "notifications", {
      customer_id,
      channel: "push",
      template: "x",
      dedupe_key: uniqueSuffix(),
    }),
    "23514",
    { constraint: "notifications_channel_check" },
  );
});

it("waitlist reasons are capacity or flag_off", async () => {
  await expectSqlError(
    insertRow(t.pool, "waitlist_entries", {
      email: "a@example.test",
      product_family: "x",
      region: "r",
      reason: "other",
    }),
    "23514",
    { constraint: "waitlist_entries_reason_check" },
  );
});

it.each(["orphan", "missing", "cost", "payment"])(
  "discrepancies take the kind %s",
  async (kind) => {
    const id = await insertRow(t.pool, "discrepancies", { kind, details: "{}" });
    expect(
      (await t.pool.query("select status from discrepancies where id = $1", [id])).rows[0].status,
    ).toBe("open");
  },
);

it("discrepancies refuse an unknown kind", async () => {
  await expectSqlError(
    insertRow(t.pool, "discrepancies", { kind: "fraud", details: "{}" }),
    "23514",
    { constraint: "discrepancies_kind_check" },
  );
});

it("a domain needs a known TLD; a hosted zone belongs to one DNS zone", async () => {
  const c = await newCustomer(t.pool);
  await insertRow(t.pool, "tlds", { tld: "xyz", synced_at: "2026-11-11T00:00:00Z" });
  await expectSqlError(
    insertRow(t.pool, "domains", {
      customer_id: c,
      resource_id: await newResource(t.pool, c, { family: "domain" }),
      name: "example.nope",
      tld: "nope",
      status: "pending",
    }),
    "23503",
  );
  await insertRow(t.pool, "domains", {
    customer_id: c,
    resource_id: await newResource(t.pool, c, { family: "domain" }),
    name: "example.xyz",
    tld: "xyz",
    status: "pending",
  });
  const zone = {
    customer_id: c,
    name: "example.xyz",
    hosted_zone_id: "Z0123456789",
    status: "pending_delegation",
  };
  const id = await insertRow(t.pool, "dns_zones", {
    ...zone,
    resource_id: await newResource(t.pool, c, { family: "dns" }),
  });
  expect(
    (await t.pool.query("select name_servers, notices_sent_at from dns_zones where id = $1", [id]))
      .rows[0],
  ).toEqual({ name_servers: [], notices_sent_at: [] });
  await expectSqlError(
    insertRow(t.pool, "dns_zones", {
      ...zone,
      resource_id: await newResource(t.pool, c, { family: "dns" }),
    }),
    "23505",
    { constraint: "dns_zones_hosted_zone_id_unique" },
  );
});

it("audit_log: a system actor has no id; IPv6 is accepted; metadata defaults to {}", async () => {
  const id = await insertRow(t.pool, "audit_log", {
    actor_type: "admin",
    actor_id: await newAdmin(t.pool),
    action: "approveAdjustment",
    ip: "2001:db8::1",
  });
  expect(
    (await t.pool.query("select metadata, host(ip) as ip from audit_log where id = $1", [id]))
      .rows[0],
  ).toEqual({ metadata: {}, ip: "2001:db8::1" });
  await expectSqlError(
    insertRow(t.pool, "audit_log", {
      actor_type: "system",
      actor_id: await newAdmin(t.pool),
      action: "x",
    }),
    "23514",
    { constraint: "audit_log_actor_check" },
  );
});

// WPU-Z5 (migration 0027): the thread of a support request.
it("a support request may be answered; an abuse case may not; the last activity defaults to now", async () => {
  const c = await newCustomer(t.pool);
  const s = await insertRow(t.pool, "support_requests", {
    customer_id: c,
    category: "billing",
    subject: "s",
    message: "m",
    status: "answered",
  });
  const row = (
    await t.pool.query(
      "select status, last_activity_at >= now() - interval '1 minute' as recent from support_requests where id = $1",
      [s],
    )
  ).rows[0];
  expect(row).toEqual({ status: "answered", recent: true });
  await expectSqlError(
    insertRow(t.pool, "support_requests", {
      customer_id: c,
      category: "billing",
      subject: "s",
      message: "m",
      status: "pending",
    }),
    "23514",
    { constraint: "support_requests_status_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "abuse_cases", {
      resource_id: await newResource(t.pool, c),
      source: "monitoring",
      status: "answered",
    }),
    "23514",
    { constraint: "abuse_cases_status_check" },
  );
});

it("support_messages: an admin message names its admin and only an admin message does; 1 to 5000 characters; a known request", async () => {
  const c = await newCustomer(t.pool);
  const admin = await newAdmin(t.pool, "support");
  const request = await insertRow(t.pool, "support_requests", {
    customer_id: c,
    category: "billing",
    subject: "s",
    message: "m",
  });
  await insertRow(t.pool, "support_messages", {
    request_id: request,
    author_type: "customer",
    body: "Any news?",
  });
  await insertRow(t.pool, "support_messages", {
    request_id: request,
    author_type: "admin",
    admin_id: admin,
    body: "x".repeat(5000),
  });
  await insertRow(t.pool, "support_messages", {
    request_id: request,
    author_type: "visitor",
    body: "বাংলা",
  });
  for (const [values, constraint] of [
    [{ author_type: "admin", body: "b" }, "support_messages_admin_check"],
    [{ author_type: "customer", admin_id: admin, body: "b" }, "support_messages_admin_check"],
    [{ author_type: "staff", body: "b" }, "support_messages_author_type_check"],
    [{ author_type: "customer", body: "" }, "support_messages_body_check"],
    [{ author_type: "customer", body: "x".repeat(5001) }, "support_messages_body_check"],
  ] as const) {
    await expectSqlError(
      insertRow(t.pool, "support_messages", { request_id: request, ...values }),
      "23514",
      { constraint },
    );
  }
  await expectSqlError(
    insertRow(t.pool, "support_messages", {
      request_id: "00000000-0000-7000-8000-000000000000",
      author_type: "customer",
      body: "b",
    }),
    "23503",
    { constraint: "support_messages_request_id_support_requests_id_fk" },
  );
});

it("abuse cases and support requests start open", async () => {
  const c = await newCustomer(t.pool);
  const a = await insertRow(t.pool, "abuse_cases", {
    resource_id: await newResource(t.pool, c),
    source: "aws_report",
  });
  const s = await insertRow(t.pool, "support_requests", {
    customer_id: c,
    category: "server",
    subject: "s",
    message: "m",
  });
  expect(
    (await t.pool.query("select status from abuse_cases where id = $1", [a])).rows[0].status,
  ).toBe("open");
  expect(
    (await t.pool.query("select status from support_requests where id = $1", [s])).rows[0].status,
  ).toBe("open");
});

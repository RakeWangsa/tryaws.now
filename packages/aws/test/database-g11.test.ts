import { awsResourceName, type OperationKind } from "@tc/core";
import { describe, expect, it } from "vitest";
import { createAwsAccessInternal } from "../access";
import { createDatabaseAdapter } from "../adapters/database";
import type { OpCtx } from "../adapters/types";
import { ASSUMED, assumeRoleOk, fakeAws, lightsailOk } from "./fake-aws";

// WPU-G11. The database adapter: read the parameters of the parameter group (only the whitelisted ones
// are kept), change them with the apply method that Lightsail reports, reboot. The names come from the
// whitelist of packages/core and the engine from the live database, never from the payload (R11).
const RID = "11111111-2222-4333-8444-555555555555";
const CID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OID = "12345678-1234-4234-8234-123456789012";
const POOL = { awsAccountId: "210987654321", externalId: "tc-ext-7f3a9c" };
const DB = awsResourceName("database", RID);
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const clock = { now: () => new Date(NOW) };

function setup(config: Record<string, unknown> = {}) {
  const aws = fakeAws();
  aws.on(
    "sts",
    "AssumeRole",
    assumeRoleOk({ ...ASSUMED, expiration: new Date(NOW + 3_600_000).toISOString() }),
  );
  const access = createAwsAccessInternal({
    caller: "provisioner",
    clock,
    requestHandler: aws.handler,
  });
  const adapter = createDatabaseAdapter({
    loadLaunch: async () => ({ bundleId: "micro_2_0", blueprintId: "mysql_8_0" }),
  });
  const ctx = (
    kind: OperationKind,
    payload: unknown,
    state = "active",
  ): OpCtx<ReturnType<typeof adapter.parseConfig>> => ({
    operation: {
      id: "op-1",
      kind,
      step: null,
      attempt: 1,
      createdAt: new Date(NOW),
      payload: payload ?? { orderId: OID },
    },
    stepKey: "op-1:start",
    resource: {
      id: RID,
      customerId: CID,
      family: "database",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state,
      config,
    },
    config: adapter.parseConfig({
      productId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      region: "ap-southeast-1",
      displayName: "Orders DB",
    }),
    account: POOL,
    region: "ap-southeast-1",
    access,
    env: "staging",
    clock,
    owned: async () => null,
  });
  const calls = () => aws.seen.filter((r) => r.service === "lightsail").map((r) => r.action);
  const bodyOf = (action: string, nth = 0) =>
    JSON.parse(aws.seen.filter((r) => r.action === action)[nth]!.body);
  const database = (extra: Record<string, unknown> = {}) =>
    lightsailOk({
      relationalDatabase: {
        name: DB,
        state: "available",
        engine: "mysql",
        parameterApplyStatus: "in-sync",
        tags: [{ key: "tc:resource", value: RID }],
        ...extra,
      },
    });
  return { aws, adapter, ctx, calls, bodyOf, database };
}

const live = (
  name: string,
  value: string,
  applyType = "dynamic",
  isModifiable = true,
): Record<string, unknown> => ({
  parameterName: name,
  parameterValue: value,
  applyType,
  isModifiable,
  applyMethod: "pending-reboot",
  description: "A long description text of the parameter that is never kept",
  allowedValues: "1-16000",
  dataType: "integer",
});
const parameters = (...items: Record<string, unknown>[]) => lightsailOk({ parameters: items });

describe("read_db_parameters", () => {
  it("keeps the whitelisted parameters only, with checked values, and the reboot flag", async () => {
    const h = setup();
    h.aws.on(
      "lightsail",
      "GetRelationalDatabase",
      h.database({ parameterApplyStatus: "pending-reboot" }),
    );
    h.aws.on(
      "lightsail",
      "GetRelationalDatabaseParameters",
      parameters(
        live("max_connections", "150"),
        live("innodb_buffer_pool_size", "123456", "static"),
        live("skip_grant_tables", "OFF"),
        live("wait_timeout", "28800", "dynamic", false),
        live("character_set_server", "klingon"),
      ),
    );
    const r = await h.adapter.aws.action("read_db_parameters", h.ctx("read_db_parameters", {}));
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          parameters: {
            engine: "mysql",
            rebootPending: true,
            readAt: new Date(NOW).toISOString(),
            items: [
              { name: "max_connections", value: "150", apply: "immediate", changeable: true },
              { name: "wait_timeout", value: "28800", apply: "immediate", changeable: false },
              { name: "character_set_server", value: null, apply: "immediate", changeable: true },
            ],
          },
        },
      },
    });
    const text = JSON.stringify(r);
    expect(text).not.toContain("skip_grant_tables");
    expect(text).not.toContain("innodb_buffer_pool_size");
    expect(text).not.toContain("long description");
    expect(h.calls()).toEqual(["GetRelationalDatabase", "GetRelationalDatabaseParameters"]);
  });

  it("refuses a database that is not active, an unknown engine and a database it cannot read (R16)", async () => {
    const busy = setup();
    await expect(
      busy.adapter.aws.action("read_db_parameters", busy.ctx("read_db_parameters", {}, "creating")),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(busy.aws.seen.length).toBe(0);

    const odd = setup();
    odd.aws.on("lightsail", "GetRelationalDatabase", odd.database({ engine: "oracle" }));
    await expect(
      odd.adapter.aws.action("read_db_parameters", odd.ctx("read_db_parameters", {})),
    ).rejects.toMatchObject({ code: "validation" });
    expect(odd.calls()).not.toContain("GetRelationalDatabaseParameters");

    const gone = setup();
    gone.aws.on("lightsail", "GetRelationalDatabase", lightsailOk({}));
    await expect(
      gone.adapter.aws.action("read_db_parameters", gone.ctx("read_db_parameters", {})),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});

describe("set_db_parameters", () => {
  it("applies a dynamic parameter at once and a static one at the next reboot, by what Lightsail reports", async () => {
    const h = setup();
    h.aws.on("lightsail", "GetRelationalDatabase", h.database(), h.database());
    h.aws.on(
      "lightsail",
      "GetRelationalDatabaseParameters",
      parameters(live("max_connections", "150", "static"), live("wait_timeout", "28800")),
      parameters(live("max_connections", "300", "static"), live("wait_timeout", "600")),
    );
    h.aws.on("lightsail", "UpdateRelationalDatabaseParameters", lightsailOk({ operations: [] }));
    const r = await h.adapter.aws.action(
      "set_db_parameters",
      h.ctx("set_db_parameters", { parameters: { wait_timeout: "600", max_connections: "300" } }),
    );
    expect(h.bodyOf("UpdateRelationalDatabaseParameters")).toEqual({
      relationalDatabaseName: DB,
      parameters: [
        { parameterName: "max_connections", parameterValue: "300", applyMethod: "pending-reboot" },
        { parameterName: "wait_timeout", parameterValue: "600", applyMethod: "immediate" },
      ],
    });
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: {
          parameters: {
            engine: "mysql",
            rebootPending: true,
            items: [
              { name: "max_connections", value: "300", apply: "pending-reboot" },
              { name: "wait_timeout", value: "600", apply: "immediate" },
            ],
          },
        },
      },
    });
    expect(h.calls()).toEqual([
      "GetRelationalDatabase",
      "GetRelationalDatabaseParameters",
      "UpdateRelationalDatabaseParameters",
      "GetRelationalDatabaseParameters",
    ]);
  });

  it("changes nothing for a name or value outside the whitelist, or a parameter Lightsail does not let change (R11, R16)", async () => {
    for (const parameters_ of [
      { skip_grant_tables: "ON" },
      { statement_timeout: "10" },
      { max_connections: "0" },
      { max_connections: "1; DROP" },
      { wait_timeout: 5 },
      {},
      null,
      "max_connections=5",
    ]) {
      const h = setup();
      h.aws.on("lightsail", "GetRelationalDatabase", h.database());
      await expect(
        h.adapter.aws.action(
          "set_db_parameters",
          h.ctx("set_db_parameters", { parameters: parameters_ }),
        ),
      ).rejects.toMatchObject({ code: "validation" });
      expect(h.calls(), JSON.stringify(parameters_)).not.toContain(
        "UpdateRelationalDatabaseParameters",
      );
    }
    const locked = setup();
    locked.aws.on("lightsail", "GetRelationalDatabase", locked.database());
    locked.aws.on(
      "lightsail",
      "GetRelationalDatabaseParameters",
      parameters(live("wait_timeout", "28800", "dynamic", false)),
    );
    await expect(
      locked.adapter.aws.action(
        "set_db_parameters",
        locked.ctx("set_db_parameters", { parameters: { wait_timeout: "600" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    expect(locked.calls()).not.toContain("UpdateRelationalDatabaseParameters");

    const missing = setup();
    missing.aws.on("lightsail", "GetRelationalDatabase", missing.database());
    missing.aws.on("lightsail", "GetRelationalDatabaseParameters", parameters());
    await expect(
      missing.adapter.aws.action(
        "set_db_parameters",
        missing.ctx("set_db_parameters", { parameters: { wait_timeout: "600" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("uses the engine of the live database, so a postgres name is refused on a mysql database", async () => {
    const h = setup();
    h.aws.on("lightsail", "GetRelationalDatabase", h.database({ engine: "postgres" }));
    h.aws.on(
      "lightsail",
      "GetRelationalDatabaseParameters",
      parameters(live("statement_timeout", "0")),
    );
    h.aws.on("lightsail", "UpdateRelationalDatabaseParameters", lightsailOk({ operations: [] }));
    await expect(
      h.adapter.aws.action(
        "set_db_parameters",
        h.ctx("set_db_parameters", { parameters: { wait_timeout: "600" } }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("refuses a database that is not active (R16)", async () => {
    const h = setup();
    await expect(
      h.adapter.aws.action(
        "set_db_parameters",
        h.ctx("set_db_parameters", { parameters: { wait_timeout: "600" } }, "stopped"),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(h.aws.seen.length).toBe(0);
  });
});

describe("reboot", () => {
  it("reboots the database under its generated name and clears the reboot flag of the saved parameters", async () => {
    const saved = {
      parameters: {
        engine: "mysql",
        rebootPending: true,
        readAt: "2026-11-12T10:00:00.000Z",
        items: [
          { name: "max_connections", value: "300", apply: "pending-reboot", changeable: true },
        ],
      },
    };
    const h = setup(saved);
    h.aws.on("lightsail", "RebootRelationalDatabase", lightsailOk({ operations: [] }));
    const r = await h.adapter.aws.action("reboot", h.ctx("reboot", {}));
    expect(h.bodyOf("RebootRelationalDatabase")).toEqual({ relationalDatabaseName: DB });
    expect(r).toMatchObject({
      kind: "done",
      patch: {
        configMerge: { parameters: { rebootPending: false, items: saved.parameters.items } },
      },
    });
  });

  it("works without saved parameters and refuses a database that is not active (R16)", async () => {
    const h = setup();
    h.aws.on("lightsail", "RebootRelationalDatabase", lightsailOk({ operations: [] }));
    const r = await h.adapter.aws.action("reboot", h.ctx("reboot", {}));
    expect(r).toMatchObject({ kind: "done" });
    expect(JSON.stringify(r)).not.toContain("parameters");
    const busy = setup();
    await expect(
      busy.adapter.aws.action("reboot", busy.ctx("reboot", {}, "stopped")),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(busy.aws.seen.length).toBe(0);
  });
});

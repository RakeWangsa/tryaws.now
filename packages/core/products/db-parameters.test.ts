import { describe, expect, it } from "vitest";
import {
  DB_PARAMETER_RULES,
  checkedDbParameterChanges,
  dbEngineFrom,
  safeDbParameterList,
} from "./db-parameters";

describe("dbEngineFrom", () => {
  it("knows mysql and postgres, in any case, and nothing else (R16)", () => {
    expect(dbEngineFrom("mysql")).toBe("mysql");
    expect(dbEngineFrom("MySQL")).toBe("mysql");
    expect(dbEngineFrom("postgres")).toBe("postgres");
    for (const bad of ["", "mariadb", "oracle", 5, null, undefined, "mysql; drop"]) {
      expect(dbEngineFrom(bad), String(bad)).toBeNull();
    }
  });
});

describe("the whitelist", () => {
  it("has rules for both engines, with plain lower-case names (R11)", () => {
    for (const engine of ["mysql", "postgres"] as const) {
      expect(DB_PARAMETER_RULES[engine].length).toBeGreaterThan(5);
      for (const rule of DB_PARAMETER_RULES[engine]) {
        expect(rule.name, rule.name).toMatch(/^[a-z][a-z0-9_]{1,62}$/);
      }
    }
  });
  it("never lists a parameter that can lock the customer out or break the platform", () => {
    const names = [...DB_PARAMETER_RULES.mysql, ...DB_PARAMETER_RULES.postgres].map((r) => r.name);
    for (const banned of [
      "skip_grant_tables",
      "local_infile",
      "init_connect",
      "log_bin_trust_function_creators",
      "ssl",
      "rds.force_ssl",
      "shared_preload_libraries",
      "password_encryption",
      "listen_addresses",
      "port",
    ]) {
      expect(names, banned).not.toContain(banned);
    }
  });
});

describe("checkedDbParameterChanges", () => {
  it("accepts whitelisted names with values in range and gives back canonical text", () => {
    const r = checkedDbParameterChanges("mysql", {
      max_connections: "200",
      slow_query_log: "1",
      character_set_server: "utf8mb4",
    });
    expect(r).toEqual({
      ok: true,
      value: [
        { name: "max_connections", value: "200" },
        { name: "slow_query_log", value: "1" },
        { name: "character_set_server", value: "utf8mb4" },
      ],
    });
    expect(checkedDbParameterChanges("postgres", { log_min_duration_statement: "-1" })).toEqual({
      ok: true,
      value: [{ name: "log_min_duration_statement", value: "-1" }],
    });
    expect(checkedDbParameterChanges("mysql", { wait_timeout: " 0300 " })).toEqual({
      ok: true,
      value: [{ name: "wait_timeout", value: "300" }],
    });
  });

  it("refuses a name that is not on the list of the engine, even if the other engine has it", () => {
    expect(checkedDbParameterChanges("mysql", { statement_timeout: "10" })).toMatchObject({
      ok: false,
      fields: { parameters: "invalid" },
    });
    expect(checkedDbParameterChanges("postgres", { wait_timeout: "10" })).toMatchObject({
      ok: false,
    });
    for (const name of ["", "Max_Connections", "max-connections", "a b", "x'; --", "__proto__"]) {
      expect(checkedDbParameterChanges("mysql", { [name]: "1" }), name).toMatchObject({
        ok: false,
      });
    }
  });

  it("refuses values out of range, with signs, decimals, text or the wrong type", () => {
    for (const [name, value] of [
      ["max_connections", "0"],
      ["max_connections", "99999999"],
      ["max_connections", "-5"],
      ["max_connections", "1.5"],
      ["max_connections", "1e3"],
      ["max_connections", "10 OR 1"],
      ["max_connections", ""],
      ["max_connections", 200],
      ["slow_query_log", "2"],
      ["slow_query_log", "on"],
      ["character_set_server", "klingon"],
      ["character_set_server", "utf8mb4;x"],
    ] as const) {
      expect(
        checkedDbParameterChanges("mysql", { [name]: value }),
        `${name}=${value}`,
      ).toMatchObject({ ok: false });
    }
    expect(
      checkedDbParameterChanges("postgres", { log_min_duration_statement: "-2" }),
    ).toMatchObject({ ok: false });
    expect(checkedDbParameterChanges("postgres", { log_statement: "everything" })).toMatchObject({
      ok: false,
    });
  });

  it("refuses an empty change, a non-object and an unknown engine (R16)", () => {
    expect(checkedDbParameterChanges("mysql", {})).toMatchObject({ ok: false });
    expect(checkedDbParameterChanges("mysql", null)).toMatchObject({ ok: false });
    expect(checkedDbParameterChanges("mysql", [])).toMatchObject({ ok: false });
    expect(checkedDbParameterChanges(null, { max_connections: "5" })).toMatchObject({ ok: false });
  });

  it("refuses more than 10 changes at once", () => {
    const rules = DB_PARAMETER_RULES.mysql;
    const ok = Object.fromEntries(
      rules.slice(0, 3).map((r) => [r.name, r.kind === "int" ? String(r.max) : "1"]),
    );
    expect(checkedDbParameterChanges("mysql", ok)).toMatchObject({ ok: true });
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`p${i + 10}`, "1"]));
    expect(checkedDbParameterChanges("mysql", many)).toMatchObject({ ok: false });
  });
});

describe("safeDbParameterList", () => {
  const live = [
    { name: "max_connections", value: "150", applyType: "dynamic", modifiable: true },
    { name: "innodb_buffer_pool_size", value: "123", applyType: "static", modifiable: true },
    { name: "wait_timeout", value: "28800", applyType: "dynamic", modifiable: false },
    { name: "slow_query_log", value: "0", applyType: "dynamic", modifiable: true },
    { name: "interactive_timeout", value: undefined, applyType: "weird", modifiable: true },
  ];
  it("keeps whitelisted parameters only, with checked values and a fixed apply word", () => {
    const list = safeDbParameterList("mysql", live);
    expect(list.map((p) => p.name)).toEqual([
      "max_connections",
      "wait_timeout",
      "interactive_timeout",
      "slow_query_log",
    ]);
    expect(list[0]).toEqual({
      name: "max_connections",
      value: "150",
      apply: "immediate",
      changeable: true,
    });
    // Not modifiable in Lightsail: shown, not changeable.
    expect(list[1]).toMatchObject({ changeable: false });
    // An unknown apply type or a missing value is never trusted.
    expect(list[2]).toEqual({
      name: "interactive_timeout",
      value: null,
      apply: "unknown",
      changeable: false,
    });
  });
  it("shows a static parameter as applied at the next reboot", () => {
    const list = safeDbParameterList("postgres", [
      { name: "max_connections", value: "100", applyType: "static", modifiable: true },
    ]);
    expect(list).toEqual([
      { name: "max_connections", value: "100", apply: "pending-reboot", changeable: true },
    ]);
  });
  it("drops a value that is too long or odd for display (R14: no raw text)", () => {
    const list = safeDbParameterList("mysql", [
      { name: "max_connections", value: "x".repeat(500), applyType: "dynamic", modifiable: true },
    ]);
    expect(list).toEqual([
      { name: "max_connections", value: null, apply: "immediate", changeable: true },
    ]);
  });
  it("is empty for an unknown engine", () => {
    expect(safeDbParameterList(null, live)).toEqual([]);
  });
});

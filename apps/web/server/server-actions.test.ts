import type { CustomerSession } from "@tc/auth";
import type { CustomerOperation, ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  addFirewallRuleCore,
  attachStaticIpCore,
  detachStaticIpCore,
  rebootServerCore,
  removeFirewallRuleCore,
  renameServerCore,
  startServerCore,
  stopServerCore,
  type ServerOpsDeps,
  type ServerOpsRepos,
} from "./server-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const SSH_RULE = { protocol: "tcp", fromPort: 22, toPort: 22, cidrs: ["0.0.0.0/0"] };

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: NOW,
});

const row = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: SERVER,
  family: "linux_instance",
  productId: null,
  region: "ap-south-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "web-1" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

const operation = (over: Partial<CustomerOperation>): CustomerOperation => ({
  id: "op-other",
  resourceId: SERVER,
  kind: "set_ports",
  state: "queued",
  step: null,
  needsApproval: false,
  createdAt: NOW,
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    flags?: Record<string, boolean>;
    allowed?: boolean;
    auditOk?: boolean;
    replay?: boolean;
    inFlight?: CustomerOperation[];
    requestError?: "not_found" | "validation";
  } = {},
) {
  const calls: string[] = [];
  const rows = over.rows ?? [row()];
  let current: CustomerSession | null = session();
  const repos: ServerOpsRepos = {
    familyOn: async (family) => {
      calls.push(`flag:${family}`);
      return over.flags === undefined ? true : over.flags[family] === true;
    },
    resources: {
      list: async () => rows,
      get: async (id) => rows.find((r) => r.id === id) ?? null,
      countLive: async () => 0,
      listChildren: async () => [],
      createBackupRow: async () => ({ ok: false, error: "validation" }),
    },
    operations: {
      get: async () => null,
      listRecent: async () => [],
      listForResource: async () => {
        calls.push("ops:list");
        return [operation({ id: "op-new", state: "queued" }), ...(over.inFlight ?? [])];
      },
      request: async (input) => {
        calls.push(
          `op:${input.kind}:${JSON.stringify(input.payload ?? null)}:${input.idempotencyKey}`,
        );
        if (over.requestError) return { ok: false, error: over.requestError };
        return {
          ok: true,
          replayed: over.replay === true,
          value: operation({ id: "op-new", kind: input.kind }),
        };
      },
    },
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}:${input.targetType}:${input.targetId}`);
        return over.auditOk === false
          ? { ok: false, error: "validation" }
          : { ok: true, replayed: false, value: { id: "a" } };
      },
    },
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.allowed === false
          ? { allowed: false, action: "x", retryAfterSeconds: 5 }
          : { allowed: true };
      },
    },
  };
  const deps: ServerOpsDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      expect(customerId).toBe(CUSTOMER);
      calls.push("store");
      return fn(repos);
    },
  };
  return { deps, calls, setSession: (s: CustomerSession | null) => (current = s) };
}

const base = { serverId: SERVER, requestId: REQ };
const wrote = (calls: string[]) => calls.some((c) => c.startsWith("op:") || c.startsWith("audit:"));

describe("R9 order: authenticate, authorize, validate, rate limit, execute, audit", () => {
  it("reboot", async () => {
    const w = world();
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: true, done: "rebooting" });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "flag:linux_instance",
      "rateLimit",
      `op:reboot:null:reboot:${REQ}`,
      "ops:list",
      `audit:server.reboot:resource:${SERVER}`,
    ]);
  });
  it("refuses without a session and opens no store", async () => {
    const w = world();
    w.setSession(null);
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual(["authenticate"]);
  });
  it("a bad form is a validation error before the store is opened", async () => {
    const w = world();
    expect(await rebootServerCore(w.deps, { serverId: "x", requestId: "y" })).toEqual({
      ok: false,
      error: "validation",
      fields: { serverId: "invalid", requestId: "invalid" },
    });
    expect(w.calls).toEqual(["authenticate"]);
  });
  it("a rate limit stops the action before an operation is written", async () => {
    const w = world({ allowed: false });
    expect(await stopServerCore(w.deps, base)).toEqual({ ok: false, error: "rate_limited" });
    expect(wrote(w.calls)).toBe(false);
  });
  it("an audit entry that cannot be written fails the whole action (R16)", async () => {
    const w = world({ auditOk: false });
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "unavailable" });
  });
  it("the flag of the server's own family decides (R12): Linux off, Windows on", async () => {
    const off = world({ flags: { windows_instance: true } });
    expect(await rebootServerCore(off.deps, base)).toEqual({ ok: false, error: "flag_off" });
    const win = world({
      rows: [row({ family: "windows_instance" })],
      flags: { windows_instance: true },
    });
    expect(await rebootServerCore(win.deps, base)).toMatchObject({ ok: true });
  });
});

describe("power: the state of the server decides", () => {
  it("reboot and stop need a running server; start needs a stopped one", async () => {
    for (const state of ["creating", "stopped", "suspended", "failed", "destroyed"] as const) {
      const w = world({ rows: [row({ state })] });
      expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "not_allowed" });
      expect(await stopServerCore(w.deps, base)).toEqual({ ok: false, error: "not_allowed" });
      expect(wrote(w.calls)).toBe(false);
    }
    const stopped = world({ rows: [row({ state: "stopped" })] });
    expect(await startServerCore(stopped.deps, base)).toEqual({ ok: true, done: "starting" });
    expect(stopped.calls).toContain(`op:start:null:start:${REQ}`);
    const running = world();
    expect(await startServerCore(running.deps, base)).toEqual({ ok: false, error: "not_allowed" });
  });
  it("a suspended server is never started by the customer: it belongs to the lifecycle", async () => {
    const w = world({ rows: [row({ state: "suspended" })] });
    expect(await startServerCore(w.deps, base)).toEqual({ ok: false, error: "not_allowed" });
  });
  it("a click twice (the same request id) is the same operation: a replay is not busy", async () => {
    const w = world({ replay: true, inFlight: [operation({ id: "op-new", kind: "reboot" })] });
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: true, done: "rebooting" });
    expect(w.calls).not.toContain("ops:list");
  });
  it("another power, firewall or IP operation on its way makes the action busy", async () => {
    for (const kind of ["reboot", "stop", "start", "set_ports", "attach_static_ip"]) {
      const w = world({ inFlight: [operation({ kind, state: "running" })] });
      expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "busy" });
      expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
    }
    // A finished one, or one of another kind (a backup), does not block.
    const free = world({
      inFlight: [
        operation({ kind: "reboot", state: "succeeded" }),
        operation({ kind: "create_backup", state: "running" }),
      ],
    });
    expect(await rebootServerCore(free.deps, base)).toMatchObject({ ok: true });
  });
});

describe("rename", () => {
  it("queues the rename with the checked name and audits it", async () => {
    const w = world();
    expect(await renameServerCore(w.deps, { ...base, displayName: "  web-2 " })).toEqual({
      ok: true,
      done: "renamed",
    });
    expect(w.calls).toContain(`op:rename:{"displayName":"web-2"}:rename:${REQ}`);
    expect(w.calls.at(-1)).toBe(`audit:server.rename:resource:${SERVER}`);
  });
  it.each(["", "a<b>", "x".repeat(61), "$(id)", "line\nbreak"])(
    "refuses the name %j",
    async (name) => {
      const w = world();
      expect(await renameServerCore(w.deps, { ...base, displayName: name })).toEqual({
        ok: false,
        error: "validation",
        fields: { displayName: "invalid" },
      });
      expect(w.calls).toEqual(["authenticate"]);
    },
  );
  it("a server that is being destroyed or failed is not renamed", async () => {
    const w = world({ rows: [row({ state: "destroyed" })] });
    expect(await renameServerCore(w.deps, { ...base, displayName: "ok" })).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });
  it("a rename does not wait for a reboot", async () => {
    const w = world({ inFlight: [operation({ kind: "reboot", state: "running" })] });
    expect(await renameServerCore(w.deps, { ...base, displayName: "ok" })).toMatchObject({
      ok: true,
    });
    expect(w.calls).not.toContain("ops:list");
  });
});

describe("firewall", () => {
  const add = (over: Record<string, unknown>) => ({
    ...base,
    preset: "https",
    sourceMode: "any",
    ...over,
  });
  it("adds a preset to the stored list (the default list until one was saved)", async () => {
    const w = world();
    expect(await addFirewallRuleCore(w.deps, add({}))).toEqual({ ok: true, done: "firewallSaved" });
    const payload = {
      ports: [SSH_RULE, { protocol: "tcp", fromPort: 443, toPort: 443, cidrs: ["0.0.0.0/0"] }],
    };
    expect(w.calls).toContain(
      `op:set_ports:${JSON.stringify(payload)}:firewall_add:${REQ}:tcp:443-443`,
    );
    expect(w.calls.at(-1)).toBe(`audit:server.firewall_add:resource:${SERVER}`);
  });
  it("adds to the saved list and restricts the source", async () => {
    const w = world({
      rows: [row({ config: { displayName: "w", firewallRules: [SSH_RULE] } })],
    });
    await addFirewallRuleCore(
      w.deps,
      add({
        preset: "custom",
        protocol: "udp",
        fromPort: "5000",
        toPort: "5010",
        sourceMode: "restrict",
        sources: "203.0.113.7, 10.0.0.0/8",
      }),
    );
    const sent = w.calls.find((c) => c.startsWith("op:set_ports:"))!;
    expect(JSON.parse(sent.split(":firewall_add")[0]!.slice("op:set_ports:".length))).toEqual({
      ports: [
        SSH_RULE,
        { protocol: "udp", fromPort: 5000, toPort: 5010, cidrs: ["203.0.113.7/32", "10.0.0.0/8"] },
      ],
    });
  });
  it("the page's copy of the list is never trusted: a 'rules' field is ignored", async () => {
    const w = world();
    await addFirewallRuleCore(
      w.deps,
      add({ rules: '[{"protocol":"tcp","fromPort":1,"toPort":65535,"cidrs":["0.0.0.0/0"]}]' }),
    );
    const sent = w.calls.find((c) => c.startsWith("op:set_ports:"))!;
    expect(sent).not.toContain("65535");
  });
  it("names every wrong field and refuses IPv6 and hostile text", async () => {
    const w = world();
    expect(
      await addFirewallRuleCore(
        w.deps,
        add({
          preset: "custom",
          protocol: "gre",
          fromPort: "0x10",
          sourceMode: "restrict",
          sources: "$(id)",
        }),
      ),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { protocol: "invalid", fromPort: "invalid", sources: "invalid" },
    });
    expect(
      await addFirewallRuleCore(w.deps, add({ sourceMode: "restrict", sources: "2001:db8::/32" })),
    ).toMatchObject({ ok: false, fields: { sources: "ipv6" } });
    expect(wrote(w.calls)).toBe(false);
  });
  it("the same protocol and range twice is a duplicate; thirty rules is the end", async () => {
    const w = world();
    expect(await addFirewallRuleCore(w.deps, add({ preset: "ssh" }))).toEqual({
      ok: false,
      error: "duplicate",
    });
    const rules = Array.from({ length: 30 }, (_, i) => ({
      ...SSH_RULE,
      fromPort: 1000 + i,
      toPort: 1000 + i,
    }));
    const full = world({ rows: [row({ config: { firewallRules: rules } })] });
    expect(await addFirewallRuleCore(full.deps, add({}))).toEqual({
      ok: false,
      error: "too_many",
    });
  });
  it("a saved list that cannot be read is not edited (R16)", async () => {
    const w = world({ rows: [row({ config: { firewallRules: "all" } })] });
    expect(await addFirewallRuleCore(w.deps, add({}))).toEqual({ ok: false, error: "unavailable" });
    expect(wrote(w.calls)).toBe(false);
  });
  it("removes a rule by its key and sends the list without it", async () => {
    const w = world();
    expect(await removeFirewallRuleCore(w.deps, { ...base, ruleKey: "tcp:22-22" })).toEqual({
      ok: true,
      done: "firewallSaved",
    });
    expect(w.calls).toContain(`op:set_ports:{"ports":[]}:firewall_remove:${REQ}:tcp:22-22`);
    expect(await removeFirewallRuleCore(w.deps, { ...base, ruleKey: "tcp:80-80" })).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await removeFirewallRuleCore(w.deps, { ...base, ruleKey: "x;y" })).toMatchObject({
      ok: false,
      error: "validation",
    });
  });
  it("a server that is not running or stopped is not edited", async () => {
    for (const state of ["creating", "suspended", "failed"] as const) {
      const w = world({ rows: [row({ state })] });
      expect(await addFirewallRuleCore(w.deps, add({}))).toEqual({
        ok: false,
        error: "not_allowed",
      });
    }
  });
  it("two edits on the way cannot overwrite each other", async () => {
    const w = world({ inFlight: [operation({ kind: "set_ports", state: "queued" })] });
    expect(await addFirewallRuleCore(w.deps, add({ preset: "http" }))).toEqual({
      ok: false,
      error: "busy",
    });
  });
});

describe("static IP", () => {
  it("detach needs the acknowledgement and an attached IP", async () => {
    const w = world();
    expect(await detachStaticIpCore(w.deps, base)).toEqual({
      ok: false,
      error: "validation",
      fields: { acknowledge: "required" },
    });
    expect(await detachStaticIpCore(w.deps, { ...base, acknowledge: "on" })).toEqual({
      ok: true,
      done: "staticIpDetaching",
    });
    expect(w.calls).toContain(`op:detach_static_ip:null:static_ip_detach:${REQ}`);
    const already = world({ rows: [row({ config: { staticIpAttached: false } })] });
    expect(await detachStaticIpCore(already.deps, { ...base, acknowledge: "on" })).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });
  it("attach needs a detached IP", async () => {
    const w = world();
    expect(await attachStaticIpCore(w.deps, base)).toEqual({ ok: false, error: "not_allowed" });
    const detached = world({ rows: [row({ config: { staticIpAttached: false } })] });
    expect(await attachStaticIpCore(detached.deps, base)).toEqual({
      ok: true,
      done: "staticIpAttaching",
    });
    expect(detached.calls).toContain(`op:attach_static_ip:null:static_ip_attach:${REQ}`);
    expect(detached.calls.at(-1)).toBe(`audit:server.static_ip_attach:resource:${SERVER}`);
  });
});

describe("R8: another customer's server answers like a missing one", () => {
  it("every action on an unknown id is not_found and writes nothing", async () => {
    const w = world({ rows: [] });
    const results = await Promise.all([
      rebootServerCore(w.deps, base),
      stopServerCore(w.deps, base),
      startServerCore(w.deps, base),
      renameServerCore(w.deps, { ...base, displayName: "x" }),
      addFirewallRuleCore(w.deps, { ...base, preset: "http", sourceMode: "any" }),
      removeFirewallRuleCore(w.deps, { ...base, ruleKey: "tcp:22-22" }),
      attachStaticIpCore(w.deps, base),
      detachStaticIpCore(w.deps, { ...base, acknowledge: "on" }),
    ]);
    for (const r of results) expect(r).toEqual({ ok: false, error: "not_found" });
    expect(wrote(w.calls)).toBe(false);
  });
  it("a resource of another family (a disk, a backup) is not a server", async () => {
    const w = world({ rows: [row({ family: "disk" })] });
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "not_found" });
  });
  it("a customerId in the form is ignored: the store is opened for the session's customer only", async () => {
    // world().deps.store asserts customerId === CUSTOMER on every call.
    const w = world({ rows: [] });
    await rebootServerCore(w.deps, { ...base, customerId: "22222222-2222-4222-8222-222222222222" });
    await addFirewallRuleCore(w.deps, {
      ...base,
      preset: "http",
      sourceMode: "any",
      customerId: "22222222-2222-4222-8222-222222222222",
    });
    expect(w.calls.filter((c) => c === "store")).toHaveLength(2);
  });
  it("the operation repository refusing the resource is the same not_found", async () => {
    const w = world({ requestError: "not_found" });
    expect(await rebootServerCore(w.deps, base)).toEqual({ ok: false, error: "not_found" });
  });
});

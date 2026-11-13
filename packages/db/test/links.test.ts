import { readFileSync } from "node:fs";
import { Resource } from "sst/resource";
import { describe, expect, it } from "vitest";
import { envLinks, secretValue, sstLinks } from "../links";

// WPU-Z15: @tc/db/links is the one reader of linked SST values of the repository (packages/db/env.ts,
// apps/web/server/secrets.ts, apps/admin/server/rate-subject.ts, functions/migrator/config.ts and
// functions/notifier/secrets.ts read through it). The SST SDK loads its links once per process, so this
// file holds the scenario "nothing linked"; the links as a deploy delivers them are in the *-sst test
// files of the readers, and a link file that does not open is database-url-sst-fail-closed.test.ts.
// Obviously fake values (R3).

describe("sstLinks, the SST SDK at run time", () => {
  it("nothing linked: undefined, never the error of the SDK (R3, R14, R16)", () => {
    expect(Object.keys(process.env).filter((name) => name.startsWith("SST_RESOURCE_"))).toEqual([]);
    for (const name of [
      "DbPasswordWorkerRw",
      "EpsHashKey",
      "AdminIpLimitKey",
      "Postgres",
      "SmsApiKey",
    ]) {
      // The premise: the SDK's own Resource throws for a name that is not linked.
      expect(() => (Resource as unknown as Record<string, unknown>)[name], name).toThrow();
      expect(sstLinks(name), name).toBeUndefined();
    }
  });
});

describe("envLinks, the variables SST_RESOURCE_<Name> of an environment object (tests, sst dev)", () => {
  it("gives the parsed JSON of the variable of the name it is asked for, and nothing else", () => {
    const links = envLinks({
      SST_RESOURCE_SmsApiKey: '{"type":"sst.sst.Secret","value":"fake-token"}',
    });
    expect(links("SmsApiKey")).toEqual({ type: "sst.sst.Secret", value: "fake-token" });
    expect(links("SmsSenderId")).toBeUndefined();
  });

  it("gives undefined for a missing variable and for text that is not JSON", () => {
    for (const raw of [undefined, "", "{not json", '{"value":"fake-cut']) {
      expect(envLinks({ SST_RESOURCE_EpsHashKey: raw })("EpsHashKey"), String(raw)).toBeUndefined();
    }
  });

  it("hands on any JSON as it is; the shape is the reader's check (secretValue)", () => {
    const links = envLinks({
      SST_RESOURCE_A: "null",
      SST_RESOURCE_B: '"text"',
      SST_RESOURCE_C: "[]",
    });
    expect(links("A")).toBeNull();
    expect(links("B")).toBe("text");
    expect(links("C")).toEqual([]);
  });

  it("reads the environment object at the time of use", () => {
    const env: Record<string, string | undefined> = {};
    const links = envLinks(env);
    expect(links("OtpHashKey")).toBeUndefined();
    env["SST_RESOURCE_OtpHashKey"] = '{"value":"fake-late"}';
    expect(links("OtpHashKey")).toEqual({ value: "fake-late" });
  });
});

describe("secretValue, the value of a linked sst.Secret", () => {
  it("gives the value when it is a string that is not empty", () => {
    expect(secretValue({ type: "sst.sst.Secret", value: "fake-value" })).toBe("fake-value");
    expect(secretValue({ value: "x" })).toBe("x");
  });

  it("gives undefined for every other shape", () => {
    const shapes: unknown[] = [
      undefined,
      null,
      "fake-value",
      42,
      true,
      [],
      ["fake-value"],
      {},
      { value: "" },
      { value: 42 },
      { value: null },
      { value: { value: "fake-value" } },
      { password: "fake-value" },
      Object.assign(() => "fake-value", { value: "fake-value" }),
    ];
    for (const shape of shapes) {
      expect(secretValue(shape), String(shape)).toBeUndefined();
    }
  });
});

it("loads only the resource entry of the SST SDK: no database driver, not the root entry of sst", () => {
  const source = readFileSync(new URL("../links.ts", import.meta.url), "utf8");
  const sources = [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map(
    (match) => match[1],
  );
  expect(sources).toEqual(["sst/resource"]);
  expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
});

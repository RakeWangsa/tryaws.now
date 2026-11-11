import { describe, expect, it } from "vitest";
import { WebConfigError, readWebConfig } from "./config.ts";

const base = { TC_STAGE: "local", APP_ORIGIN: "http://localhost:3000", NODE_ENV: "development" };

function problem(env: Record<string, string | undefined>): WebConfigError {
  try {
    readWebConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(WebConfigError);
    return error as WebConfigError;
  }
  throw new Error("readWebConfig did not throw");
}

describe("readWebConfig: stages and fakes", () => {
  it("local and test stages honour TC_EPS=fake in development and test", () => {
    expect(readWebConfig({ ...base, TC_EPS: "fake" })).toEqual({
      stage: "local",
      appOrigin: "http://localhost:3000",
      epsMode: "sandbox",
      fakes: true,
    });
    expect(
      readWebConfig({ ...base, TC_STAGE: "test", NODE_ENV: "test", TC_EPS: "fake" }).fakes,
    ).toBe(true);
  });

  it("fakes stay off without TC_EPS=fake", () => {
    expect(readWebConfig(base).fakes).toBe(false);
    expect(readWebConfig({ ...base, TC_EPS: "" }).fakes).toBe(false);
  });

  it("production and staging refuse TC_EPS=fake", () => {
    for (const stage of ["production", "staging"]) {
      const env = {
        TC_STAGE: stage,
        APP_ORIGIN: "https://cloud.example.com",
        NODE_ENV: "production",
        TC_EPS: "fake",
      };
      expect(() => readWebConfig(env), stage).toThrow(WebConfigError);
      expect(() => readWebConfig({ ...env, NODE_ENV: "development" }), stage).toThrow(
        WebConfigError,
      );
    }
  });

  it("NODE_ENV=production with stage local refuses TC_EPS=fake", () => {
    expect(() => readWebConfig({ ...base, NODE_ENV: "production", TC_EPS: "fake" })).toThrow(
      WebConfigError,
    );
    expect(() => readWebConfig({ ...base, NODE_ENV: undefined, TC_EPS: "fake" })).toThrow(
      WebConfigError,
    );
  });

  it("any other TC_EPS value is refused", () => {
    expect(() => readWebConfig({ ...base, TC_EPS: "real" })).toThrow(WebConfigError);
  });

  it("an unknown or missing stage is refused", () => {
    expect(() => readWebConfig({ ...base, TC_STAGE: "prod" })).toThrow(WebConfigError);
    expect(() => readWebConfig({ ...base, TC_STAGE: undefined })).toThrow(WebConfigError);
  });

  it("epsMode is production only for the production stage", () => {
    const https = { APP_ORIGIN: "https://cloud.example.com", NODE_ENV: "production" };
    expect(readWebConfig({ ...https, TC_STAGE: "production" }).epsMode).toBe("production");
    expect(readWebConfig({ ...https, TC_STAGE: "staging" }).epsMode).toBe("sandbox");
    expect(readWebConfig(base).epsMode).toBe("sandbox");
  });
});

describe("readWebConfig: the origin", () => {
  it("accepts a plain https origin, with or without the final slash and with a port", () => {
    const env = { TC_STAGE: "production", NODE_ENV: "production" };
    expect(readWebConfig({ ...env, APP_ORIGIN: "https://cloud.example.com" }).appOrigin).toBe(
      "https://cloud.example.com",
    );
    expect(readWebConfig({ ...env, APP_ORIGIN: "https://cloud.example.com/" }).appOrigin).toBe(
      "https://cloud.example.com",
    );
    expect(readWebConfig({ ...env, APP_ORIGIN: "https://cloud.example.com:8443" }).appOrigin).toBe(
      "https://cloud.example.com:8443",
    );
  });

  it("http is accepted for localhost in local and test only", () => {
    expect(readWebConfig({ ...base, TC_STAGE: "test" }).appOrigin).toBe("http://localhost:3000");
    for (const stage of ["staging", "production"]) {
      expect(() =>
        readWebConfig({ ...base, TC_STAGE: stage, APP_ORIGIN: "http://localhost:3000" }),
      ).toThrow(WebConfigError);
    }
  });

  it("refuses everything that is not a plain origin", () => {
    for (const origin of [
      "http://example.com",
      "https://cloud.example.com/path",
      "https://cloud.example.com/?x=1",
      "https://cloud.example.com/#x",
      "https://user:pw@cloud.example.com",
      "ftp://cloud.example.com",
      "javascript:alert(1)",
      "cloud.example.com",
      "",
      "http://localhost",
      "http://evil.localhost:3000",
      "http://localhost:3000/x",
    ]) {
      expect(() => readWebConfig({ ...base, APP_ORIGIN: origin }), origin).toThrow(WebConfigError);
    }
    expect(() => readWebConfig({ ...base, APP_ORIGIN: undefined })).toThrow(WebConfigError);
  });

  it("no thrown text contains a rejected value", () => {
    const planted = "planted-value-7f3a";
    const cases: Record<string, string | undefined>[] = [
      { ...base, TC_STAGE: planted },
      { ...base, APP_ORIGIN: `https://${planted}.example.com/path` },
      { ...base, APP_ORIGIN: `http://${planted}.com` },
      { ...base, TC_EPS: planted },
      { ...base, NODE_ENV: planted, TC_EPS: "fake" },
    ];
    for (const env of cases) {
      const error = problem(env);
      expect(error.message).not.toContain(planted);
      expect(error.message).not.toContain("example.com");
      expect(String(error.stack)).not.toContain(planted);
    }
  });
});

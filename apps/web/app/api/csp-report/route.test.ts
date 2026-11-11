import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route.ts";

function post(body: string, contentType: string): Request {
  return new Request("http://localhost:3000/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

function spyOnStdout() {
  return vi.spyOn(process.stdout, "write").mockImplementation(() => true);
}

const legacy = JSON.stringify({
  "csp-report": {
    "document-uri": "https://cloud.example.com/servers?token=secret#frag",
    "violated-directive": "script-src",
    "blocked-uri": "https://evil.example.com/x.js?q=1",
    disposition: "report",
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/csp-report", () => {
  it("answers 204 and writes one JSON line without query string for a report-uri body", async () => {
    const write = spyOnStdout();
    const response = await POST(post(legacy, "application/csp-report"));
    expect(response.status).toBe(204);
    expect(write).toHaveBeenCalledTimes(1);
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain("secret");
    expect(line).not.toContain("q=1");
    expect(line).not.toContain("frag");
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed["event"]).toBe("csp.violation");
    expect(parsed["app"]).toBe("web");
    expect(parsed["directive"]).toBe("script-src");
  });

  it("writes one line per report of a report-to array, at most 10", async () => {
    const write = spyOnStdout();
    const entry = {
      type: "csp-violation",
      body: {
        effectiveDirective: "img-src",
        blockedURL: "https://x.example.com/a.png",
        documentURL: "https://cloud.example.com/",
      },
    };
    const response = await POST(
      post(JSON.stringify(Array.from({ length: 15 }, () => entry)), "application/reports+json"),
    );
    expect(response.status).toBe(204);
    expect(write).toHaveBeenCalledTimes(10);
  });

  it("answers 204 and writes nothing for garbage", async () => {
    const write = spyOnStdout();
    for (const [body, type] of [
      ["not json{", "application/csp-report"],
      ["[1,2,3]", "application/reports+json"],
      ["{}", "text/plain"],
    ] as const) {
      const response = await POST(post(body, type));
      expect(response.status, body).toBe(204);
    }
    expect(write).not.toHaveBeenCalled();
  });

  it("answers 413 over 16384 bytes and writes nothing", async () => {
    const write = spyOnStdout();
    const response = await POST(post("x".repeat(16385), "application/csp-report"));
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("");
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts a body of exactly 16384 bytes", async () => {
    spyOnStdout();
    const response = await POST(post("x".repeat(16384), "application/csp-report"));
    expect(response.status).toBe(204);
  });

  it("answers without a body", async () => {
    spyOnStdout();
    const response = await POST(post(legacy, "application/csp-report"));
    expect(await response.text()).toBe("");
  });
});

describe("GET /api/csp-report", () => {
  it("answers 405 with Allow: POST", async () => {
    const response = GET();
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.text()).toBe("");
  });
});

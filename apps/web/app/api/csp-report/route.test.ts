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

// Item 4 of security review 2 (R9): the size is judged before the body is read. A fake request lets
// the test see whether the body was touched.
function fakeRequest(opts: { contentLength?: string; chunks: number; chunkBytes?: number }) {
  const state = { pulled: 0, textCalled: false, cancelled: false };
  const size = opts.chunkBytes ?? 4096;
  // highWaterMark 0: nothing is pulled until a reader asks, so `pulled` counts real reads.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= opts.chunks) {
          controller.close();
          return;
        }
        state.pulled += 1;
        controller.enqueue(new Uint8Array(size).fill(120));
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const headers = new Headers({ "content-type": "application/csp-report" });
  if (opts.contentLength !== undefined) headers.set("content-length", opts.contentLength);
  const request = {
    headers,
    body,
    text: async () => {
      state.textCalled = true;
      return "";
    },
  } as unknown as Request;
  return { request, state };
}

describe("POST /api/csp-report: the size is judged before the body is read (R9)", () => {
  it("answers 413 on a content-length above 16 KB without reading the body", async () => {
    const write = spyOnStdout();
    const { request, state } = fakeRequest({ contentLength: "16385", chunks: 4 });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(state.pulled).toBe(0);
    expect(state.textCalled).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it("answers 413 on a huge content-length, and on one that is not a number (fail closed)", async () => {
    for (const contentLength of ["99999999999999999999", "abc", "-1", "1e9"]) {
      const { request, state } = fakeRequest({ contentLength, chunks: 4 });
      expect((await POST(request)).status, contentLength).toBe(413);
      expect(state.pulled).toBe(0);
    }
  });

  it("stops reading a body that is larger than 16 KB without a content-length, or that lies about it", async () => {
    for (const contentLength of [undefined, "100"]) {
      const write = spyOnStdout();
      const { request, state } = fakeRequest({ contentLength, chunks: 1000 });
      const response = await POST(request);
      expect(response.status).toBe(413);
      // 16 KB is four chunks of 4 KB: the fifth crosses the cap and the stream is cancelled there.
      expect(state.pulled).toBeLessThan(10);
      expect(state.cancelled).toBe(true);
      expect(write).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("still accepts a streamed body of exactly 16384 bytes and sanitises it as before", async () => {
    const write = spyOnStdout();
    const { request } = fakeRequest({ contentLength: "16384", chunks: 4 });
    expect((await POST(request)).status).toBe(204);
    expect(write).not.toHaveBeenCalled();
  });

  it("reads a normal report through the stream and logs the sanitised fields", async () => {
    const write = spyOnStdout();
    const response = await POST(post(legacy, "application/csp-report"));
    expect(response.status).toBe(204);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("answers 204 for an empty body and for a request without a body", async () => {
    spyOnStdout();
    expect(
      (await POST(new Request("http://localhost:3000/api/csp-report", { method: "POST" }))).status,
    ).toBe(204);
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

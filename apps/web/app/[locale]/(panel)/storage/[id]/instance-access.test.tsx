import { describe, expect, it, vi } from "vitest";
import { html } from "../../_family/render-html.tsx";
import { BucketInstanceAccess } from "./BucketInstanceAccess.tsx";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

// WPU-G9: the Resource access section of a bucket.
const BUCKET = "0190aaaa-0000-7000-8000-0000000000b1";
const I1 = "0190aaaa-0000-7000-8000-0000000000c1";
const I2 = "0190aaaa-0000-7000-8000-0000000000c2";
const REQ1 = "0190aaaa-0000-7000-8000-0000000000f1";
const REQ2 = "0190aaaa-0000-7000-8000-0000000000f2";
const noop = async () => ({});
const render = (
  instances: { id: string; name: string; allowed: boolean }[],
  locale: "bn" | "en" = "en",
  mode: "private" | "public" | null = "private",
) =>
  html(
    <BucketInstanceAccess
      action={noop}
      bucketId={BUCKET}
      requestIds={{ [I1]: REQ1, [I2]: REQ2 }}
      instances={instances}
      mode={mode}
    />,
    locale,
  );

describe("bucket resource access section", () => {
  it("one form per server: allow where there is none, remove where there is; each with its own request id (R7)", () => {
    const out = render([
      { id: I1, name: "web", allowed: false },
      { id: I2, name: "worker", allowed: true },
    ]);
    expect(out).toContain(`name="instanceId" value="${I1}"`);
    expect(out).toContain(`name="requestId" value="${REQ1}"`);
    expect(out).toContain(`name="requestId" value="${REQ2}"`);
    expect(out).toContain('name="access" value="allow"');
    expect(out).toContain('name="access" value="deny"');
    expect(out).toContain("Give access");
    expect(out).toContain("Remove access");
    expect(out).toContain("Has access");
    expect(out).not.toMatch(/ style="/);
  });
  it("says what the current mode is, or that it is not known yet", () => {
    expect(render([], "en", "public")).toContain("Open to all");
    expect(render([], "en", "private")).toContain("Private: files can be read only with your keys");
    expect(render([], "en", null)).toContain("Not known yet");
  });
  it("empty state and Bengali", () => {
    expect(render([])).toContain("no running or stopped server");
    expect(render([{ id: I1, name: "web", allowed: false }], "bn")).toMatch(/[ঀ-৿]/);
  });
});

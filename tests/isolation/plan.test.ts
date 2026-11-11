import { bootstrapScript } from "../../packages/aws/adapters/bootstrap";
import { expect, it } from "vitest";
import { MANUAL_CASES, REQUIRED_POOL, TCP_CASES, skipReason } from "./cases";

it("the cases are those of 10.4 item 7", () => {
  expect(TCP_CASES.filter((c) => c.expect === "blocked").map((c) => c.port)).toEqual([
    22, 443, 3306, 40000,
  ]);
  expect(TCP_CASES.filter((c) => c.expect === "recorded").map((c) => c.port)).toEqual([80]);
  expect(MANUAL_CASES.join("\n")).toMatch(
    /UDP[\s\S]*Docker[\s\S]*health check[\s\S]*DHCP[\s\S]*IPv6/,
  );
});

it("the isolation test is skipped with a clear reason unless a real pool is named", () => {
  expect(skipReason({})).toMatch(/needs a real pool/);
  expect(skipReason({ TC_ISOLATION_POOL: "tc-pool-prod" })).toMatch(/skipped locally/);
  expect(skipReason({ TC_ISOLATION_POOL: REQUIRED_POOL })).toMatch(/missing/);
  expect(
    skipReason({
      TC_ISOLATION_POOL: REQUIRED_POOL,
      TC_ISOLATION_A_PRIVATE_IP: "172.26.1.2",
      TC_ISOLATION_B_SSH: "ubuntu@203.0.113.7",
      TC_ISOLATION_B_KEY_FILE: "/k",
    }),
  ).toBeNull();
});

it("the template under test opens none of the tested ports and drops the rest", () => {
  const script = bootstrapScript({ vpcCidr: "172.26.0.0/16" });
  for (const c of TCP_CASES) expect(script).not.toMatch(new RegExp(`dport ${c.port}\\b`));
  expect(script).toContain("} drop");
});

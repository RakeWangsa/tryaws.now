import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MANUAL_CASES, TCP_CASES, skipReason } from "./cases";

// 10.4 item 7, the real part: runs only against two instances of two test customers in tc-pool-dev.
// Locally it is skipped with the reason of `skipReason`. It makes no AWS API call itself: it connects
// from B (ssh, key by path) to A's private IP. The ssh key file is never read by this test.
const reason = skipReason(process.env);

function tryTcp(port: number): Promise<boolean> {
  const a = process.env.TC_ISOLATION_A_PRIVATE_IP as string;
  const b = process.env.TC_ISOLATION_B_SSH as string;
  const key = process.env.TC_ISOLATION_B_KEY_FILE as string;
  return new Promise((resolve) => {
    execFile(
      "ssh",
      [
        "-i",
        key,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=10",
        b,
        `timeout 4 bash -c '</dev/tcp/${a}/${port}'`,
      ],
      (error) => resolve(error === null),
    );
  });
}

describe.skipIf(reason !== null)("isolation in tc-pool-dev", () => {
  for (const c of TCP_CASES) {
    it(`B ${c.expect === "blocked" ? "cannot" : "may (recorded)"} open tcp ${c.port} (${c.name}) on A's private IP`, async () => {
      const open = await tryTcp(c.port);
      if (c.expect === "blocked") expect(open).toBe(false);
      else console.log(JSON.stringify({ event: "isolation_recorded", port: c.port, open }));
    }, 30_000);
  }
  for (const manual of MANUAL_CASES) it.todo(`manual: ${manual}`);
});

// Shows the reason in the test report when the real part is skipped.
it.skipIf(reason === null)(`real pool needed: ${reason ?? "n/a"}`, () => {});

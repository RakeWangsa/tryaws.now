import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { generateRsaKeyPair } from "../../apps/web/app/[locale]/(panel)/servers/new/ssh-keygen.ts";

// WPU-G10. The key pair that the create wizard makes in the browser is read by the real OpenSSH tool: the
// private file is accepted by `ssh-keygen -y` and gives the public key of the line that the server stores.
// It lives here because a test of an app may not start a process (R1). Skipped where ssh-keygen is not
// installed (the structure of the file is proved in the web test with node:crypto).
const hasKeygen = spawnSync("ssh-keygen", ["-h"], { stdio: "ignore" }).error === undefined;

it.skipIf(!hasKeygen)(
  "the private key file of a generated pair is read by ssh-keygen and gives the same public key",
  async () => {
    const pair = await generateRsaKeyPair("agree");
    const dir = mkdtempSync(join(tmpdir(), "tc-keygen-"));
    try {
      const file = join(dir, "id");
      writeFileSync(file, pair.privateKey, { mode: 0o600 });
      const out = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim();
      expect(out.split(" ").slice(0, 2).join(" ")).toBe(
        pair.publicKey.split(" ").slice(0, 2).join(" "),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

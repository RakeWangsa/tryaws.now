// Final review M3: one UUID check (isUuid / UUID_PATTERN of @tc/core, packages/core/validation/uuid.ts) for the
// id fields named by the review, instead of a regex of their own each. R1 holds (no app imports packages/aws for
// it) and packages/core stays pure (the check is a regex, no I/O).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(join(root, path), "utf8");
const LOCAL_UUID_REGEX = /\/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/;

describe("the shared UUID check", () => {
  const users = {
    "apps/web/server/support-view.ts": '"@tc/core"',
    "apps/web/server/support-thread-actions.ts": '"@tc/core"',
    "apps/web/server/family-actions.ts": '"@tc/core"',
    "functions/provisioner/reject.ts": '"@tc/core"',
    "apps/admin/server/case-data.ts": '"@tc/core"',
    "packages/core/lifecycle/domain-renewal.ts": '"../validation/uuid"',
  };

  it("is defined once, in packages/core/validation, without I/O", () => {
    const text = read("packages/core/validation/uuid.ts");
    expect(text).toMatch(LOCAL_UUID_REGEX);
    expect(text).not.toMatch(/^import /m);
    expect(read("packages/core/validation/index.ts")).toContain(
      'export { isUuid, UUID_PATTERN } from "./uuid";',
    );
  });

  it("is the one used by the files of the review, which hold no UUID regex of their own", () => {
    for (const [file, from] of Object.entries(users)) {
      const text = read(file);
      expect(text, file).not.toMatch(LOCAL_UUID_REGEX);
      expect(text, file).toMatch(new RegExp(`import \\{[^}]*\\bisUuid\\b[^}]*\\} from ${from};`));
    }
  });
});

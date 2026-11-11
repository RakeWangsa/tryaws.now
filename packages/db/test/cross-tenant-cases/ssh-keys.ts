import { uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

export const sshKeysCases: CaseSet = defineCaseSet<{ customerId: string; sshKeyId: string }>({
  repo: "sshKeys",
  seed: async (pool, customerId) => ({
    customerId,
    sshKeyId: await insertRow(pool, "ssh_keys", {
      customer_id: customerId,
      name: "seed",
      public_key: "ssh-ed25519 AAAAseed",
      fingerprint: "SHA256:seed-" + uniqueSuffix(),
    }),
  }),
  cases: ({ asCustomer }) => ({
    "sshKeys.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.sshKeys.list()) },
    "sshKeys.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.sshKeys.get(s.sshKeyId)),
    },
    "sshKeys.add": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.sshKeys.add({
            name: "laptop",
            publicKey: "ssh-ed25519 AAAAlaptop",
            fingerprint: "SHA256:laptop",
          }),
        ),
    },
    "sshKeys.remove": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.sshKeys.remove(s.sshKeyId)),
    },
  }),
});

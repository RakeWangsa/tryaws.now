import { kycKeyOwnedBy } from "@tc/core";
import type {
  KycCrypto,
  KycObjectStore,
  KycUploadCheck,
  KycUploadState,
  PresignedUpload,
  UploadRequest,
} from "@tc/core";

// Development and test only (see eps-bridge.ts): an object store that keeps sizes and types in
// memory and has no method that reads content, a stand-in of the kyc-check function (WPU-Y3) that
// answers from that memory, and a crypto that only wraps text. Nothing here reaches AWS. The
// production runtime does not load this file (runtime.ts, config.fakes).

interface Stored {
  readonly size: number;
  readonly contentType: string;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};

export class FakeKycObjectStore implements KycObjectStore {
  private readonly objects = new Map<string, Stored>();

  /** Development: every signed key counts as uploaded (the fake URL receives nothing). Tests: false. */
  constructor(private readonly acceptSigned = false) {}
  readonly presigned: UploadRequest[] = [];

  async presignUpload(request: UploadRequest): Promise<PresignedUpload> {
    this.presigned.push(request);
    return {
      url: "fake://kyc-upload",
      fields: { key: request.key, "Content-Type": request.contentType },
    };
  }

  /** What the fake bucket holds at `key`: size and type only (the kyc-check stand-in reads it). */
  uploaded(key: string): Stored | null {
    const known = this.objects.get(key);
    if (known !== undefined) return known;
    const signed = this.presigned.find((request) => request.key === key);
    return this.acceptSigned && signed !== undefined
      ? { size: 1, contentType: BY_EXTENSION[key.split(".").pop() ?? ""] ?? "" }
      : null;
  }

  /** What the browser's POST would have done; a test or the dev bridge calls it. */
  simulateUpload(key: string, size: number, contentType: string): void {
    this.objects.set(key, { size, contentType });
  }
}

/** Like functions/kyc-check: the key must be the customer's own KYC key (R8), then size and type only. */
export class FakeKycUploadCheck implements KycUploadCheck {
  constructor(private readonly store: FakeKycObjectStore) {}

  async check(customerId: string, key: string): Promise<KycUploadState> {
    if (!kycKeyOwnedBy(key, customerId))
      throw new Error("kyc-check: the upload could not be checked");
    const found = this.store.uploaded(key);
    return found === null
      ? { present: false }
      : { present: true, size: found.size, contentType: found.contentType };
  }
}

export class FakeKycCrypto implements KycCrypto {
  async seal(plaintext: string): Promise<Uint8Array> {
    // Not encryption: a marker and the bytes of a hash-sized stand-in, so a stored row is never the
    // plain number in a test database.
    return new TextEncoder().encode(`fake-seal:${plaintext.length}:${"x".repeat(32)}`);
  }
}

interface DevKyc {
  objects: FakeKycObjectStore;
  crypto: FakeKycCrypto;
  check: FakeKycUploadCheck;
}

export function getDevKyc(): DevKyc {
  const holder = globalThis as unknown as Record<string, DevKyc | undefined>;
  if (holder["__tcDevKyc"] === undefined) {
    const objects = new FakeKycObjectStore(true);
    holder["__tcDevKyc"] = {
      objects,
      crypto: new FakeKycCrypto(),
      check: new FakeKycUploadCheck(objects),
    };
  }
  return holder["__tcDevKyc"];
}

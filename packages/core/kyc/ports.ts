import type { KycContentType } from "./rules";

// WP2-T4: what the identity check needs from the outside, as types only. The web role can ask for an
// upload; it has no method that reads an object (the bucket policy of the real store denies GetObject,
// GetObjectVersion and ListBucket to the web role as well). The real adapters (S3 presigned POST and KMS
// data key) are a manual VERIFY of the staging deploy.
//
// WPU-Y3: whether an upload arrived is asked of the kyc-check function (KycUploadCheck), not of S3 by the
// web role: S3 HeadObject needs s3:GetObject, which the web role must not have.

export interface PresignedUpload {
  readonly url: string;
  /** The form fields that go with the file in the POST; they carry the signed policy. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface UploadRequest {
  readonly key: string;
  readonly contentType: KycContentType;
  readonly maxBytes: number;
  readonly expiresSeconds: number;
}

export interface KycObjectStore {
  /** The policy fixes the key, the content type and the size range of the one file. */
  presignUpload(request: UploadRequest): Promise<PresignedUpload>;
}

/** What the kyc-check function tells about one object: never its content. */
export type KycUploadState =
  | { readonly present: false }
  | { readonly present: true; readonly size: number; readonly contentType: string };

export interface KycUploadCheck {
  /**
   * The size and type of the object at `key`, which must be a key of kycObjectKey for `customerId` (the
   * implementation checks it again, R8). Throws when the check cannot complete (R16).
   */
  check(customerId: string, key: string): Promise<KycUploadState>;
}

export interface KycCrypto {
  /** The KMS envelope of the plaintext (encrypted data key and ciphertext), as stored in the row. */
  seal(plaintext: string): Promise<Uint8Array>;
}

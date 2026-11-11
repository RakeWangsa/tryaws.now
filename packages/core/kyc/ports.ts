import type { KycContentType } from "./rules";

// WP2-T4: what the identity check needs from the outside, as types only. The web role can ask for an
// upload and can ask whether it arrived; it has no method that reads an object (the bucket policy
// of the real store denies GetObject to the web role as well). The real adapters (S3 presigned POST
// and KMS data key) are a manual VERIFY of the staging deploy.

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
  /** The size and type of an uploaded object, or null when there is none. Never its content. */
  head(key: string): Promise<{ readonly size: number; readonly contentType: string } | null>;
}

export interface KycCrypto {
  /** The KMS envelope of the plaintext (encrypted data key and ciphertext), as stored in the row. */
  seal(plaintext: string): Promise<Uint8Array>;
}

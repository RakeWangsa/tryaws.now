// WPU-Y5 (e): the SSH public keys a Linux server can be created with. Lightsail ImportKeyPair documents
// publicKeyBase64 as "A base64-encoded public key of the `ssh-rsa` type" (API reference, read 2026-11-14), and no
// Lightsail page documents Ed25519 or ECDSA (docs/analysis/verify-review-2026-11-13.md, JOURNEY.md:427). So the web
// accepts, and the provisioner sends, only one OpenSSH `ssh-rsa` line with a modulus of 2048 to 16384 bits.
// Pure: no I/O, no Node API (atob is in browsers and in Node), so the web and packages/aws share it.

export const SSH_RSA_MIN_BITS = 2048;
// OpenSSH refuses RSA keys above 16384 bits (SSHBUF_MAX_BIGNUM); a larger one is not a real key.
export const SSH_RSA_MAX_BITS = 16384;

const TYPE = "ssh-rsa";
const LINE = /^ssh-rsa ([A-Za-z0-9+/]+={0,2})$/;
// The blob of a 16384 bit key is about 2 KB; 4 KB leaves room and bounds the work.
const MAX_BLOB_BYTES = 4096;

function decode(data: string): Uint8Array | null {
  if (data.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Reads the SSH `string` fields of a blob (RFC 4251 section 5); null when the blob is not exactly those fields. */
function fields(blob: Uint8Array, count: number): Uint8Array[] | null {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < count; i += 1) {
    if (at + 4 > blob.length) return null;
    const length =
      (blob[at] ?? 0) * 2 ** 24 +
      ((blob[at + 1] ?? 0) << 16) +
      ((blob[at + 2] ?? 0) << 8) +
      (blob[at + 3] ?? 0);
    at += 4;
    if (length > blob.length - at) return null;
    out.push(blob.subarray(at, at + length));
    at += length;
  }
  return at === blob.length ? out : null;
}

/** The bit length of a positive SSH mpint; null for zero, a negative number or a needless leading zero byte. */
function positiveBits(mpint: Uint8Array): number | null {
  const first = mpint[0];
  if (first === undefined) return null;
  if (first & 0x80) return null; // negative
  let at = 0;
  if (first === 0) {
    // a leading zero is allowed only to keep the next byte's top bit from reading as a sign
    if (mpint.length < 2 || ((mpint[1] ?? 0) & 0x80) === 0) return null;
    at = 1;
  }
  const top = mpint[at] ?? 0;
  return (mpint.length - at - 1) * 8 + (32 - Math.clz32(top));
}

/**
 * The modulus size in bits of an OpenSSH `ssh-rsa` public line (`ssh-rsa <base64 blob>`, no comment, nothing
 * around it), or null when the value is anything else: another type, a malformed blob, a blob whose embedded type
 * is not ssh-rsa, trailing bytes, a missing or non-positive exponent or modulus.
 */
export function sshRsaKeyBits(line: unknown): number | null {
  if (typeof line !== "string") return null;
  const match = LINE.exec(line);
  if (match === null) return null;
  const blob = decode(match[1] as string);
  if (blob === null || blob.length > MAX_BLOB_BYTES) return null;
  const parts = fields(blob, 3);
  if (parts === null) return null;
  const [type, e, n] = parts as [Uint8Array, Uint8Array, Uint8Array];
  if (String.fromCharCode(...type) !== TYPE) return null;
  if (positiveBits(e) === null) return null;
  return positiveBits(n);
}

/** Whether Lightsail ImportKeyPair can take the key: an ssh-rsa line of 2048 to 16384 bits (fail closed, R16). */
export function isImportableSshKey(line: unknown): boolean {
  const bits = sshRsaKeyBits(line);
  return bits !== null && bits >= SSH_RSA_MIN_BITS && bits <= SSH_RSA_MAX_BITS;
}

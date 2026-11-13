// WPU-G10, WPU-Y5 (e). The key pair the create wizard makes in the browser, like the Lightsail console does: an
// RSA pair (3072 bits, e = 65537) from Web Crypto, written in the OpenSSH formats. RSA because Lightsail
// ImportKeyPair documents publicKeyBase64 as "a base64-encoded public key of the ssh-rsa type" and no Lightsail page
// documents Ed25519 (docs/analysis/verify-review-2026-11-13.md); the key page accepts ssh-rsa of 2048 bits or more.
// The private key exists only in this browser tab: this module has no network call, no log and no storage, and the
// page hands the private key to the customer as a download, once. Only the public line is ever sent to the server
// (R3, R14). No dependency: the formats are a few length-prefixed fields (RFC 4253 section 6.6 and the OpenSSH
// PROTOCOL.key file format).

const TYPE = "ssh-rsa";
const MAGIC = "openssh-key-v1\0";
export const RSA_BITS = 3072;
const MIN_BITS = 2048;
const MAX_BITS = 16384;

/** The parts of an RSA private key, as unsigned big-endian numbers (the JWK fields n, e, d, p, q, qi). */
export interface RsaKeyParts {
  readonly n: Uint8Array;
  readonly e: Uint8Array;
  readonly d: Uint8Array;
  readonly p: Uint8Array;
  readonly q: Uint8Array;
  /** q^-1 mod p (OpenSSH calls it iqmp). */
  readonly qi: Uint8Array;
}

const text = (value: string): Uint8Array => Uint8Array.from(value, (ch) => ch.charCodeAt(0) & 0xff);

function u32(value: number): Uint8Array {
  return Uint8Array.from([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An SSH `string`: a 4 byte length and the bytes. */
const field = (bytes: Uint8Array): Uint8Array => concat(u32(bytes.length), bytes);

/** Leading zero bytes removed. */
function trimmed(bytes: Uint8Array): Uint8Array {
  let at = 0;
  while (at < bytes.length && bytes[at] === 0) at += 1;
  return bytes.subarray(at);
}

/** An SSH `mpint` of a positive number: no leading zeros, and one zero byte when the top bit is set. */
function mpint(bytes: Uint8Array): Uint8Array {
  const value = trimmed(bytes);
  return field((value[0] ?? 0) & 0x80 ? concat(Uint8Array.of(0), value) : value);
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64Url(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("unexpected key format");
  }
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (ch) =>
    ch.charCodeAt(0),
  );
}

function bitsOf(bytes: Uint8Array): number {
  const value = trimmed(bytes);
  return value.length === 0 ? 0 : (value.length - 1) * 8 + (32 - Math.clz32(value[0] ?? 0));
}

function checkPublic(n: Uint8Array, e: Uint8Array): void {
  const bits = bitsOf(n);
  if (bits < MIN_BITS || bits > MAX_BITS) {
    throw new RangeError(`the modulus must have ${MIN_BITS} to ${MAX_BITS} bits`);
  }
  if (bitsOf(e) < 2) throw new RangeError("the public exponent is not valid");
}

/** The public key blob: `ssh-rsa`, the exponent and the modulus (RFC 4253 section 6.6). */
function publicBlob(n: Uint8Array, e: Uint8Array): Uint8Array {
  return concat(field(text(TYPE)), mpint(e), mpint(n));
}

/**
 * The public key as one line for authorized_keys: the type and the base64 blob. The comment is left out
 * on purpose: the key's name is the customer's own text and is stored beside the key, not inside it.
 */
export function openSshPublicLineOf(key: {
  readonly n: Uint8Array;
  readonly e: Uint8Array;
}): string {
  checkPublic(key.n, key.e);
  return `${TYPE} ${base64(publicBlob(key.n, key.e))}`;
}

/** The private key as an unencrypted OpenSSH file (`-----BEGIN OPENSSH PRIVATE KEY-----`), 70 columns. */
export function openSshPrivateKeyOf(key: RsaKeyParts, comment: string): string {
  checkPublic(key.n, key.e);
  for (const part of [key.d, key.p, key.q, key.qi]) {
    if (!(part instanceof Uint8Array) || bitsOf(part) === 0) {
      throw new RangeError("a private part of the key is missing");
    }
  }
  // The check number only has to be the same twice; it tells a reader that the file was decrypted.
  const check = crypto.getRandomValues(new Uint8Array(4));
  const inner = concat(
    check,
    check,
    field(text(TYPE)),
    mpint(key.n),
    mpint(key.e),
    mpint(key.d),
    mpint(key.qi),
    mpint(key.p),
    mpint(key.q),
    field(text(comment.replace(/[^\x20-\x7e]/g, "?"))),
  );
  // Padding 1, 2, 3 ... up to the block size of the "none" cipher (8).
  const pad = (8 - (inner.length % 8)) % 8;
  const padded = concat(
    inner,
    Uint8Array.from({ length: pad }, (_, i) => i + 1),
  );
  const file = concat(
    text(MAGIC),
    field(text("none")),
    field(text("none")),
    field(new Uint8Array(0)),
    u32(1),
    field(publicBlob(key.n, key.e)),
    field(padded),
  );
  inner.fill(0);
  padded.fill(0);
  const lines = base64(file).match(/.{1,70}/g) ?? [];
  file.fill(0);
  return [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    ...lines,
    "-----END OPENSSH PRIVATE KEY-----",
    "",
  ].join("\n");
}

/** The name of the downloaded file: the key's name with only safe characters, and `.pem`. */
export function fileNameOfPrivateKey(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? "";
  const safe = last
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 60);
  return `${safe === "" ? "tc-key" : safe}.pem`;
}

export interface GeneratedKeyPair {
  /** One line, for the server. */
  readonly publicKey: string;
  /** The file for the customer; never sent anywhere. */
  readonly privateKey: string;
}

/**
 * Makes an RSA pair with the browser's Web Crypto. Rejects when the browser cannot (the wizard then offers the
 * other two ways: an existing key, or a public key the customer pastes).
 */
export async function generateRsaKeyPair(comment: string): Promise<GeneratedKeyPair> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("web crypto is not available");
  const pair = (await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: RSA_BITS,
      publicExponent: Uint8Array.of(1, 0, 1),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  const parts: RsaKeyParts = {
    n: fromBase64Url(jwk.n),
    e: fromBase64Url(jwk.e),
    d: fromBase64Url(jwk.d),
    p: fromBase64Url(jwk.p),
    q: fromBase64Url(jwk.q),
    qi: fromBase64Url(jwk.qi),
  };
  const privateKey = openSshPrivateKeyOf(parts, comment);
  const publicKey = openSshPublicLineOf(parts);
  // The private numbers are not kept: the only copy of the private key is the file text above.
  for (const secret of [parts.d, parts.p, parts.q, parts.qi]) secret.fill(0);
  return { publicKey, privateKey };
}

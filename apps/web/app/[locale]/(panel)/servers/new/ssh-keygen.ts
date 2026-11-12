// WPU-G10. The key pair the create wizard makes in the browser, like the Lightsail console does: an
// Ed25519 pair from Web Crypto, written in the OpenSSH formats. The private key exists only in this
// browser tab: this module has no network call, no log and no storage, and the page hands the private key to
// the customer as a download, once. Only the public line is ever sent to the server (R3, R14).
// No dependency: the formats are a few length-prefixed fields (RFC 4253 section 6.6 and the OpenSSH
// PROTOCOL.key file format).

const TYPE = "ssh-ed25519";
const MAGIC = "openssh-key-v1\0";
const SEED_BYTES = 32;
const PUBLIC_BYTES = 32;
// PKCS#8 of an Ed25519 key: a 16 byte prefix and then the 32 byte seed.
const PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

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

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sized(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new RangeError(`${what} must be ${length} bytes`);
  }
}

/** The public key blob: `ssh-ed25519` and the 32 key bytes. */
function publicBlob(publicKey: Uint8Array): Uint8Array {
  return concat(field(text(TYPE)), field(publicKey));
}

/**
 * The public key as one line for authorized_keys: the type and the base64 blob. The comment is left out
 * on purpose: the key's name is the customer's own text and is stored beside the key, not inside it.
 */
export function openSshPublicLineOf(publicKey: Uint8Array): string {
  sized(publicKey, PUBLIC_BYTES, "the public key");
  return `${TYPE} ${base64(publicBlob(publicKey))}`;
}

/** The private key as an unencrypted OpenSSH file (`-----BEGIN OPENSSH PRIVATE KEY-----`), 70 columns. */
export function openSshPrivateKeyOf(
  seed: Uint8Array,
  publicKey: Uint8Array,
  comment: string,
): string {
  sized(seed, SEED_BYTES, "the seed");
  sized(publicKey, PUBLIC_BYTES, "the public key");
  // The check number only has to be the same twice; it tells a reader that the file was decrypted.
  const check = crypto.getRandomValues(new Uint8Array(4));
  const inner = concat(
    check,
    check,
    field(text(TYPE)),
    field(publicKey),
    field(concat(seed, publicKey)),
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
    field(publicBlob(publicKey)),
    field(padded),
  );
  const lines = base64(file).match(/.{1,70}/g) ?? [];
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
 * Makes a pair with the browser's Web Crypto. Rejects when the browser has no Ed25519 (the wizard then
 * offers the other two ways: an existing key, or a public key the customer pastes).
 */
export async function generateEd25519KeyPair(comment: string): Promise<GeneratedKeyPair> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error("web crypto is not available");
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (pkcs8.length !== PKCS8_PREFIX.length + SEED_BYTES) throw new Error("unexpected key format");
  const seed = pkcs8.slice(PKCS8_PREFIX.length);
  const privateKey = openSshPrivateKeyOf(seed, publicKey, comment);
  // The seed is not kept: the only copy of the private key is the file text above.
  seed.fill(0);
  pkcs8.fill(0);
  return { publicKey: openSshPublicLineOf(publicKey), privateKey };
}

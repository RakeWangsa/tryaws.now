import { isIP, isIPv4, isIPv6 } from "node:net";
import { mac } from "./codes";

// A version 8 UUID (RFC 9562) derived from the customer and the idempotency key: the same request
// gives the same challenge id, and the primary key is the unique key (R7).
export function challengeIdFor(pepper: string, customerId: string, idempotencyKey: string): string {
  const bytes = Buffer.from(
    mac(pepper, "tc.otp.id.v1", customerId, idempotencyKey).subarray(0, 16),
  );
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The subject of a rate-limit key for a number: 128 bits of a keyed hash, so the key table never
// holds a phone number (R14).
export function phoneSubject(pepper: string, e164: string): string {
  return mac(pepper, "tc.rl.phone.v1", e164).subarray(0, 16).toString("hex");
}

const hextet = (h: string): number => Number.parseInt(h, 16);

// The address a limit counts: IPv4 as it is, IPv4-mapped IPv6 as its IPv4, other IPv6 as its first
// 64 bits (a customer's network owns a whole /64), and null for anything else (R16).
export function limitAddress(ip: string): string | null {
  if (typeof ip !== "string") return null;
  const bare = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  const family = isIP(bare);
  if (family === 4) return bare;
  if (family !== 6) return null;
  let canonical: string;
  try {
    canonical = new URL("http://[" + bare + "]/").hostname.slice(1, -1);
  } catch {
    return null;
  }
  // The canonical form has no dotted tail. Expand "::" to eight hextets.
  const [head = "", tail] = canonical.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const missing = 8 - front.length - back.length;
  if (tail === undefined ? front.length !== 8 : missing < 0) return null;
  const groups =
    tail === undefined ? front : [...front, ...Array<string>(missing).fill("0"), ...back];
  const numbers = groups.map(hextet);
  if (numbers.length !== 8 || numbers.some((n) => !Number.isInteger(n))) return null;
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = numbers;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`;
  }
  return [a, b, c, d].map((n) => n.toString(16)).join(":");
}

export function ipSubject(pepper: string, ip: string): string | null {
  const address = limitAddress(ip);
  return address === null
    ? null
    : mac(pepper, "tc.rl.ip.v1", address).subarray(0, 16).toString("hex");
}

// The subject of a rate-limit key for an email address (normalised by the caller): 128 bits of a keyed
// hash, so the key table never holds an address (R14). With `pairIp` the counter is per address
// and per client network (the sign-in pair rule); an unusable pair address is null (R16).
export function emailSubject(pepper: string, email: string, pairIp?: string): string | null {
  if (pairIp === undefined) {
    return mac(pepper, "tc.rl.email.v1", email).subarray(0, 16).toString("hex");
  }
  const address = limitAddress(pairIp);
  if (address === null) return null;
  return mac(pepper, "tc.rl.email.v1", email, address).subarray(0, 16).toString("hex");
}

const PORT = /^[0-9]{1,5}$/;
const validPort = (text: string): boolean =>
  PORT.test(text) && Number(text) >= 1 && Number(text) <= 65535;

// The header CloudFront-Viewer-Address holds the address and the source port. Only a.b.c.d:port
// and [ipv6]:port are accepted; anything else is null (R16). x-forwarded-for is never read: every
// entry of it before the last is written by the client (open point 22).
export function viewerAddress(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const v6 = /^\[([^\]]+)\]:([0-9]+)$/.exec(value);
  if (v6 !== null) {
    const address = v6[1] as string;
    return !address.includes("%") && isIPv6(address) && validPort(v6[2] as string) ? address : null;
  }
  const v4 = /^([0-9.]+):([0-9]+)$/.exec(value);
  if (v4 !== null) {
    const address = v4[1] as string;
    return isIPv4(address) && validPort(v4[2] as string) ? address : null;
  }
  return null;
}

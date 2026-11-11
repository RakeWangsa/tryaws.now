// Test code only: node:crypto is allowed here and nowhere in the production files of this package.
// The keys exist in memory for one test run. They are never written to disk (a key file would be a
// secret in the repository, and the sandbox denies *.pem).
import {
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import type { JwksCache, JwkWithKid } from "aws-jwt-verify/jwk";
import type { PoolConfig } from "../config";
import { createStaticJwksCache } from "./issuer";

export interface AccessClaims {
  sub: string;
  iat: number;
  auth_time: number;
  exp: number;
  iss: string;
  client_id: string;
  token_use: "access" | "id";
  jti: string;
  origin_jti: string;
  scope: string;
  username: string;
  version: number;
  [k: string]: unknown;
}

export interface SignOptions {
  kid?: string;
  alg?: "RS256" | "none" | "HS256";
  // "other" signs with a second key pair that has the same kid.
  key?: "issuer" | "other";
}

export interface TestIssuer {
  readonly pool: PoolConfig;
  readonly issuer: string;
  readonly jwksCache: JwksCache;
  sign(claims?: Partial<AccessClaims>, options?: SignOptions): string;
}

const KID = "test-key-1";

function b64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createTestIssuer(
  clock: { now(): Date } = { now: () => new Date() },
  overrides?: { pool?: Partial<PoolConfig> },
): TestIssuer {
  const pool: PoolConfig = {
    region: "ap-southeast-1",
    userPoolId: "ap-southeast-1_TESTPOOL1",
    clientId: "testclient0123456789abcdef",
    ...overrides?.pool,
  };
  const issuer = `https://cognito-idp.${pool.region}.amazonaws.com/${pool.userPoolId}`;

  const primary = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = {
    ...primary.publicKey.export({ format: "jwk" }),
    kid: KID,
    alg: "RS256",
    use: "sig",
  } as JwkWithKid;
  const publicPem = primary.publicKey.export({ type: "spki", format: "pem" }).toString();

  const defaults = (): AccessClaims => {
    const now = Math.floor(clock.now().getTime() / 1000);
    return {
      sub: randomUUID(),
      iat: now,
      auth_time: now,
      exp: now + 3600,
      iss: issuer,
      client_id: pool.clientId,
      token_use: "access",
      jti: randomUUID(),
      origin_jti: randomUUID(),
      scope: "aws.cognito.signin.user.admin",
      username: "test-user",
      version: 2,
    };
  };

  return {
    pool,
    issuer,
    jwksCache: createStaticJwksCache([publicJwk]),
    sign(claims = {}, options = {}) {
      const alg = options.alg ?? "RS256";
      const header = { alg, kid: options.kid ?? KID, typ: "JWT" };
      // A claim given as undefined is dropped by JSON.stringify: that is how a test omits one.
      const payload = { ...defaults(), ...claims };
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      if (alg === "none") return `${input}.`;
      if (alg === "HS256") {
        // The algorithm-confusion attack: the public key text used as an HMAC secret.
        return `${input}.${b64url(createHmac("sha256", publicPem).update(input).digest())}`;
      }
      const privateKey: KeyObject = (options.key === "other" ? other : primary).privateKey;
      return `${input}.${b64url(cryptoSign("RSA-SHA256", Buffer.from(input), privateKey))}`;
    },
  };
}

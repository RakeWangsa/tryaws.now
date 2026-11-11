// Test code only. A JWKS cache that knows the keys it was given and nothing else, so a test never
// opens a connection (the library's own cache would call https for an unknown kid).
import { KidNotFoundInJwksError } from "aws-jwt-verify/error";
import type { Jwks, JwksCache, JwkWithKid } from "aws-jwt-verify/jwk";

export function createStaticJwksCache(keys: readonly JwkWithKid[]): JwksCache {
  const find = (kid: string | undefined): JwkWithKid => {
    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk) throw new KidNotFoundInJwksError("JWK for the kid is not in the static key set");
    return jwk;
  };
  const jwks = (): Jwks => ({ keys: [...keys] });
  return {
    getJwk: (_uri, decomposedJwt) => {
      try {
        return Promise.resolve(find(decomposedJwt.header.kid));
      } catch (e) {
        return Promise.reject(e);
      }
    },
    getCachedJwk: (_uri, decomposedJwt) => find(decomposedJwt.header.kid),
    addJwks: () => {},
    getJwks: () => Promise.resolve(jwks()),
  };
}

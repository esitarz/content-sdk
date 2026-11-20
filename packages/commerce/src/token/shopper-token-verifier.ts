import { CONTEXT_ID_HEADER } from '../constants';
import { CommerceError } from '../errors';
import { buildProxyUrl, commerceFetch } from '../http';
import { ShopperUserType } from '../models';
import { createSingleFlight } from './single-flight';

/**
 * Configuration for {@link createShopperTokenVerifier}.
 * @public
 */
export interface ShopperTokenVerifierConfig {
  contextId: string;
  edgeUrl?: string;
  allowedClientIds: string[];
  expectedAudience?: string | string[];
  keyCacheTtlMs?: number;
  clockToleranceMs?: number;
  timeout?: number;
  fetch?: typeof fetch;
}

/**
 * Claims returned after server-side shopper-token verification.
 * @public
 */
export interface VerifiedShopperToken {
  clientId: string;
  userType: ShopperUserType;
  username?: string;
  expiresAt: number;
}

interface TokenHeader {
  alg?: string;
  kid?: string;
}

interface TokenClaims {
  aud?: string | string[];
  cid?: string;
  exp?: number;
  nbf?: number;
  usr?: string;
  usrtype?: string;
}

interface PublicKeyJwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

interface KeyCacheEntry {
  expiresAt: number;
  key?: CryptoKey;
  error?: CommerceError;
  promise?: Promise<CryptoKey>;
}

const keyCache = new Map<string, KeyCacheEntry>();
const DEFAULT_KEY_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CLOCK_TOLERANCE_MS = 60 * 1000;

const invalidToken = (message: string): CommerceError =>
  new CommerceError(message, { source: 'sdk', code: 'invalid-token' });

const decodeJsonPart = (value: string): unknown => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};

const decodeSignature = (value: string): Uint8Array => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};

const asObject = <T extends object>(value: unknown, message: string): T => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidToken(message);
  return value as T;
};

const normalizeAudience = (audience: string | string[] | undefined): string[] | undefined =>
  audience === undefined ? undefined : Array.isArray(audience) ? audience : [audience];

const toUserType = (claims: TokenClaims): ShopperUserType => {
  if (claims.usr !== undefined && typeof claims.usr !== 'string') {
    throw invalidToken('Shopper token has an invalid username claim.');
  }
  if (typeof claims.usrtype !== 'string') {
    throw invalidToken('Shopper token has an invalid user type claim.');
  }
  const type = claims.usrtype?.toLowerCase();
  if (type === 'anon' || type === 'anonymous' || (type === 'buyer' && !claims.usr)) {
    return 'anonymous';
  }
  if (type === 'user' || type === 'registered' || (type === 'buyer' && !!claims.usr)) {
    return 'registered';
  }
  throw invalidToken('Shopper token has an unknown user type.');
};

const getKey = async (
  config: Required<Pick<ShopperTokenVerifierConfig, 'contextId' | 'keyCacheTtlMs'>> &
    Pick<ShopperTokenVerifierConfig, 'edgeUrl' | 'timeout' | 'fetch'>,
  kid: string
): Promise<CryptoKey> => {
  const cacheKey = `${buildProxyUrl(config.edgeUrl, '')}|${config.contextId}|${kid}`;
  const existing = keyCache.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    if (existing.promise) return existing.promise;
    if (existing.key) return existing.key;
    if (existing.error) throw existing.error;
  }

  const flight = createSingleFlight<CryptoKey>();
  const promise = flight.run(async () => {
    let jwk: PublicKeyJwk;
    try {
      jwk = await commerceFetch<PublicKeyJwk>(
        buildProxyUrl(config.edgeUrl, `/oauth/certs/${encodeURIComponent(kid)}`),
        {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            [CONTEXT_ID_HEADER]: config.contextId,
          },
        },
        { timeout: config.timeout, fetch: config.fetch }
      );
    } catch (error) {
      if (error instanceof CommerceError && error.status === 404) {
        throw invalidToken('OrderCloud signing key was not found.');
      }
      throw error;
    }

    if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.kid && jwk.kid !== kid)) {
      throw invalidToken('OrderCloud certs endpoint returned an invalid signing key.');
    }

    try {
      return await globalThis.crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
    } catch {
      throw invalidToken('OrderCloud certs endpoint returned an invalid signing key.');
    }
  });
  const expiresAt = Date.now() + config.keyCacheTtlMs;
  keyCache.set(cacheKey, { expiresAt, promise });

  try {
    const key = await promise;
    keyCache.set(cacheKey, { expiresAt, key });
    return key;
  } catch (error) {
    if (error instanceof CommerceError && error.code === 'invalid-token') {
      keyCache.set(cacheKey, { expiresAt, error });
    } else {
      keyCache.delete(cacheKey);
    }
    throw error;
  }
};

/**
 * Creates a verifier for shopper tokens issued in the configured commerce proxy environment.
 * @param {ShopperTokenVerifierConfig} config verifier configuration
 * @returns {object} verifier
 * @public
 */
export function createShopperTokenVerifier(config: ShopperTokenVerifierConfig): {
  verify(token: string): Promise<VerifiedShopperToken>;
} {
  if (!config?.contextId) {
    throw new CommerceError('ShopperTokenVerifier: contextId is required.', { source: 'sdk' });
  }
  const allowedClientIds = [...new Set((config.allowedClientIds ?? []).filter(Boolean))];
  if (!allowedClientIds.length) {
    throw new CommerceError('ShopperTokenVerifier: allowedClientIds is required.', {
      source: 'sdk',
    });
  }
  const allowedAudience = normalizeAudience(config.expectedAudience);
  const ttl = config.keyCacheTtlMs ?? DEFAULT_KEY_CACHE_TTL_MS;
  const tolerance = config.clockToleranceMs ?? DEFAULT_CLOCK_TOLERANCE_MS;

  return {
    verify: async (token: string): Promise<VerifiedShopperToken> => {
      const parts = typeof token === 'string' ? token.split('.') : [];
      if (parts.length !== 3 || parts.some((part) => !part)) {
        throw invalidToken('Malformed shopper token.');
      }

      let header: TokenHeader;
      let claims: TokenClaims;
      try {
        header = asObject<TokenHeader>(decodeJsonPart(parts[0]), 'Malformed shopper token header.');
        claims = asObject<TokenClaims>(decodeJsonPart(parts[1]), 'Malformed shopper token claims.');
      } catch (error) {
        if (error instanceof CommerceError) throw error;
        throw invalidToken('Malformed shopper token.');
      }

      if (header.alg !== 'RS256') throw invalidToken('Shopper token must use RS256.');
      if (
        typeof header.kid !== 'string' ||
        !header.kid ||
        !/^[A-Za-z0-9_-]+$/.test(header.kid)
      ) {
        throw invalidToken('Shopper token has an invalid key id.');
      }
      if (typeof claims.cid !== 'string' || !allowedClientIds.includes(claims.cid)) {
        throw invalidToken('Shopper token client is not allowed.');
      }
      if (allowedAudience) {
        const tokenAudience = normalizeAudience(claims.aud) ?? [];
        if (!tokenAudience.some((value) => allowedAudience.includes(value))) {
          throw invalidToken('Shopper token audience is not allowed.');
        }
      }

      const now = Date.now();
      if (
        typeof claims.exp !== 'number' ||
        !Number.isFinite(claims.exp) ||
        now >= claims.exp * 1000 + tolerance
      ) {
        throw invalidToken('Shopper token is expired.');
      }
      if (claims.nbf !== undefined) {
        if (
          typeof claims.nbf !== 'number' ||
          !Number.isFinite(claims.nbf) ||
          now + tolerance < claims.nbf * 1000
        ) {
          throw invalidToken('Shopper token is not active yet.');
        }
      }
      const userType = toUserType(claims);

      const key = await getKey(
        {
          contextId: config.contextId,
          edgeUrl: config.edgeUrl,
          keyCacheTtlMs: ttl,
          timeout: config.timeout,
          fetch: config.fetch,
        },
        header.kid
      );
      const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      let valid: boolean;
      try {
        valid = await globalThis.crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          key,
          decodeSignature(parts[2]),
          signingInput
        );
      } catch {
        throw invalidToken('Shopper token signature is invalid.');
      }
      if (!valid) throw invalidToken('Shopper token signature is invalid.');

      const result: VerifiedShopperToken = {
        clientId: claims.cid,
        userType,
        expiresAt: claims.exp * 1000,
      };
      if (claims.usr) result.username = claims.usr;
      return result;
    },
  };
}

/**
 * Clears cached signing keys. Intended for tests and credential rotation.
 * @internal
 */
export function clearShopperTokenVerifierCache(): void {
  keyCache.clear();
}

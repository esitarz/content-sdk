import { CommerceError } from '../errors';
import { ShopperUserType } from '../models';
import { CommerceTokenClient, TokenClientResult } from './token-client';

/**
 * Creates a token client for a caller-supplied shopper access token.
 * The token can be used once per service instance but can never be refreshed or replaced.
 * @param {string} accessToken shopper access token
 * @param {ShopperUserType} [userType] shopper type
 * @returns {CommerceTokenClient} static token client
 * @public
 */
export function createStaticTokenClient(
  accessToken: string,
  userType: ShopperUserType = 'anonymous'
): CommerceTokenClient {
  const normalized = typeof accessToken === 'string' ? accessToken.trim() : '';
  if (!normalized) {
    throw new CommerceError('A shopper access token is required.', { source: 'sdk' });
  }

  let issued = false;
  const rejected = () =>
    Promise.reject(
      new CommerceError('The static shopper token was rejected and cannot be renewed.', {
        source: 'sdk',
        status: 401,
        code: 'invalid-token',
      })
    );
  const result = (): TokenClientResult => {
    issued = true;
    return {
      persisted: false,
      session: {
        accessToken: normalized,
        expiresAt: Number.MAX_SAFE_INTEGER,
        userType,
      },
    };
  };

  return {
    getAnonymousToken: () => (issued ? rejected() : Promise.resolve(result())),
    refresh: rejected,
  };
}

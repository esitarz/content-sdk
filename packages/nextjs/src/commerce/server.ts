import 'server-only';
import {
  CommerceTokenClient,
  OrderCloudService,
  ShopperSessionManager,
  ShopperUserType,
  createMemoryTokenStore,
  createStaticTokenClient,
} from '@sitecore-content-sdk/commerce';

export {
  createShopperTokenVerifier,
  createStaticTokenClient,
  ShopperTokenVerifierConfig,
  VerifiedShopperToken,
} from '@sitecore-content-sdk/commerce';

/**
 * Configuration for {@link createShopperService}.
 * @public
 */
export interface CreateShopperServiceConfig {
  contextId: string;
  edgeUrl?: string;
  accessToken: string;
  userType?: ShopperUserType;
  timeout?: number;
  fetch?: typeof fetch;
}

/**
 * Extracts a bearer token from an Authorization header. Cookies are never inspected.
 * @param {Request} request request to inspect
 * @returns {string | null} bearer token, or null for a missing/malformed header
 * @public
 */
export function readBearerToken(request: Request): string | null {
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

/**
 * Creates an `OrderCloudService` bound to one request's shopper token. The service never mints or
 * refreshes a different identity.
 * @param {CreateShopperServiceConfig} config shopper service configuration
 * @returns {OrderCloudService} per-request shopper service
 * @public
 */
export function createShopperService(config: CreateShopperServiceConfig): OrderCloudService {
  const tokenClient: CommerceTokenClient = createStaticTokenClient(
    config.accessToken,
    config.userType
  );
  const sessionManager = new ShopperSessionManager({
    tokenClient,
    tokenStore: createMemoryTokenStore(),
  });
  return new OrderCloudService({
    contextId: config.contextId,
    edgeUrl: config.edgeUrl,
    timeout: config.timeout,
    fetch: config.fetch,
    sessionManager,
  });
}

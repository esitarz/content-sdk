import { isOrderCloudError } from '../errors';

/**
 * Checks whether an error is an OrderCloud "not found" response for a product.
 * Returns false for a commerce proxy 404 (endpoint not enabled), so proxy misconfiguration is not
 * mistaken for a missing product.
 * @param {unknown} error error to inspect
 * @returns {boolean} true only for an OrderCloud 404
 * @public
 */
export function isProductNotFoundError(error: unknown): boolean {
  return isOrderCloudError(error, { status: 404 });
}

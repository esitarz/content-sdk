import { BuyerProduct, CommerceError, ListProductsOptions } from '@sitecore-content-sdk/commerce';

/**
 * Normalizes an unknown error into a CommerceError.
 * @param {unknown} error error to normalize
 * @returns {CommerceError} commerce error
 * @internal
 */
export const toCommerceError = (error: unknown): CommerceError =>
  error instanceof CommerceError
    ? error
    : new CommerceError((error as Error)?.message || 'Commerce request failed.', {
        source: 'sdk',
      });

/**
 * Checks whether an error is an abort error.
 * @param {unknown} error error to inspect
 * @returns {boolean} true for AbortError
 * @internal
 */
export const isAbortError = (error: unknown) =>
  (error as Error | undefined)?.name === 'AbortError';

/**
 * Error used when the commerce service disappears while a load is in progress.
 * @returns {CommerceError} sdk error
 * @internal
 */
export const serviceUnavailableError = () =>
  new CommerceError('Commerce service is not available.', { source: 'sdk' });

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
};

/**
 * Stable key for list params: property order does not matter and undefined values are ignored.
 * @param {ListProductsOptions} params list params
 * @returns {string} key
 * @internal
 */
export const productListKey = (params: ListProductsOptions | undefined) =>
  JSON.stringify(sortKeys(params ?? {}));

/**
 * Drops list entries without a product ID.
 * @param {T[] | undefined} items raw list items
 * @returns {T[]} items with an ID
 * @internal
 */
export const withProductIds = <T extends BuyerProduct<unknown>>(items: T[] | undefined): T[] =>
  (Array.isArray(items) ? items : []).filter(
    (item) => typeof item?.ID === 'string' && item.ID.trim() !== ''
  );

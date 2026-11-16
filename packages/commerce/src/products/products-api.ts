import { CommerceError } from '../errors';
import { CommerceRequestOptions } from '../models';
import { BuyerProduct, ListPage, Spec, Variant } from '../ordercloud-types';
import { listAll } from '../pagination';
import { ListOptions, ListProductsOptions, serializeListOptions } from '../query';

/**
 * Options for list endpoints that can follow pages.
 * @public
 */
export interface ListAllPagesOptions extends ListOptions {
  /**
   * Follow `Meta.TotalPages` and return every item in one page (with `pageSize` 100 unless set).
   * `page` is ignored when true.
   * @default true
   */
  all?: boolean;
  /**
   * Maximum number of pages followed when `all` is true. Stops at the cap with a debug log.
   * @default 20
   */
  maxPages?: number;
}

/**
 * Buyer product operations (`/v1/me/products`).
 * @public
 */
export interface ProductsApi {
  /**
   * Gets a product visible to the current shopper (`GET /v1/me/products/{productID}`).
   */
  get<TXp = Record<string, unknown>>(
    productId: string,
    options?: CommerceRequestOptions
  ): Promise<BuyerProduct<TXp>>;
  /**
   * Lists products visible to the current shopper (`GET /v1/me/products`).
   */
  list<TXp = Record<string, unknown>>(
    params?: ListProductsOptions,
    options?: CommerceRequestOptions
  ): Promise<ListPage<BuyerProduct<TXp>>>;
  /**
   * Lists the specs of a product (`GET /v1/me/products/{productID}/specs`). Follows pages by default.
   */
  listSpecs(
    productId: string,
    params?: ListAllPagesOptions,
    options?: CommerceRequestOptions
  ): Promise<ListPage<Spec>>;
  /**
   * Lists the variants of a product (`GET /v1/me/products/{productID}/variants`). Follows pages by default.
   */
  listVariants(
    productId: string,
    params?: ListAllPagesOptions,
    options?: CommerceRequestOptions
  ): Promise<ListPage<Variant>>;
}

/**
 * Sends a request through the service request pipeline.
 * @internal
 */
export type ProductsRequest = <T>(path: `/v1/${string}`, init: RequestInit) => Promise<T>;

const productPath = (productId: string): `/v1/${string}` => {
  const id = typeof productId === 'string' ? productId.trim() : '';
  if (!id) {
    throw new CommerceError('A product ID is required.', { source: 'sdk' });
  }
  return `/v1/me/products/${encodeURIComponent(id)}`;
};

const withQuery = (path: `/v1/${string}`, query: string): `/v1/${string}` =>
  query ? `${path}?${query}` : path;

/**
 * Creates the products namespace for an OrderCloud service.
 * @param {ProductsRequest} request authorized request function
 * @returns {ProductsApi} products API
 * @internal
 */
export function createProductsApi(request: ProductsRequest): ProductsApi {
  const get = <T>(path: `/v1/${string}`, options?: CommerceRequestOptions) =>
    request<T>(path, { ...options, method: 'GET' });

  const listPaged = async <T>(
    path: `/v1/${string}`,
    params: ListAllPagesOptions = {},
    options?: CommerceRequestOptions
  ): Promise<ListPage<T>> => {
    const { all = true, maxPages, ...listParams } = params;
    if (!all) {
      return get<ListPage<T>>(withQuery(path, serializeListOptions(listParams)), options);
    }
    // validate filters before the first request
    serializeListOptions(listParams);
    return listAll<T>(
      (page, pageSize) =>
        get<ListPage<T>>(
          withQuery(path, serializeListOptions({ ...listParams, page, pageSize })),
          options
        ),
      { pageSize: listParams.pageSize, maxPages, signal: options?.signal }
    );
  };

  return {
    get: async <TXp>(productId: string, options?: CommerceRequestOptions) =>
      get<BuyerProduct<TXp>>(productPath(productId), options),
    list: async <TXp>(params?: ListProductsOptions, options?: CommerceRequestOptions) =>
      get<ListPage<BuyerProduct<TXp>>>(
        withQuery('/v1/me/products', serializeListOptions(params)),
        options
      ),
    listSpecs: async (productId, params, options) =>
      listPaged<Spec>(`${productPath(productId)}/specs`, params, options),
    listVariants: async (productId, params, options) =>
      listPaged<Variant>(`${productPath(productId)}/variants`, params, options),
  };
}

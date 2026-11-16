/* eslint-disable no-redeclare */
import { useContext } from 'react';
import { BuyerProduct, CommerceError } from '@sitecore-content-sdk/commerce';
import { ProductContext } from './ProductProvider';

/**
 * Product load status.
 * @public
 */
export type ProductStatus = 'idle' | 'loading' | 'success' | 'not-found' | 'error';

/**
 * Options for product hooks.
 * @public
 */
export interface ProductHookOptions {
  /**
   * Return null instead of throwing outside a `ProductProvider`.
   */
  optional?: boolean;
}

/**
 * State returned by `useProduct`.
 * @public
 */
export interface UseProductState<TProduct = BuyerProduct, TXp = Record<string, unknown>> {
  productId: string | undefined;
  /**
   * Product after `select`.
   */
  product: TProduct | null;
  rawProduct: BuyerProduct<TXp> | null;
  status: ProductStatus;
  /**
   * True during the first load only.
   */
  isLoading: boolean;
  /**
   * True while reloading with data still shown (identity change, revalidation, refetch).
   */
  isRefetching: boolean;
  isSuccess: boolean;
  isNotFound: boolean;
  isError: boolean;
  error: CommerceError | null;
  /**
   * Reloads the product and its options.
   */
  refetch(): Promise<void>;
}

/**
 * Error thrown when a product hook is used outside a `ProductProvider`.
 * @param {string} hook hook name
 * @returns {Error} error
 * @internal
 */
export const missingProductProvider = (hook: string) =>
  new Error(`${hook} must be used within a ProductProvider.`);

/**
 * Returns the product loaded by the nearest `ProductProvider`. Does not re-render on selection changes.
 * `TProduct` and `TXp` are type assertions matching the provider's `select` and product xp.
 * @returns {UseProductState} product state
 * @throws {Error} outside a `ProductProvider`
 * @public
 */
export function useProduct<
  TProduct = BuyerProduct,
  TXp = Record<string, unknown>
>(): UseProductState<TProduct, TXp>;
/**
 * Returns the product loaded by the nearest `ProductProvider`, or null outside one.
 * @param {object} options hook options
 * @param {true} options.optional return null outside a `ProductProvider`
 * @returns {UseProductState | null} product state or null
 * @public
 */
export function useProduct<TProduct = BuyerProduct, TXp = Record<string, unknown>>(options: {
  optional: true;
}): UseProductState<TProduct, TXp> | null;
/**
 * Implementation of `useProduct`.
 * @param {ProductHookOptions} [options] hook options
 * @returns {UseProductState | null} product state or null
 */
export function useProduct<TProduct = BuyerProduct, TXp = Record<string, unknown>>(
  options?: ProductHookOptions
): UseProductState<TProduct, TXp> | null {
  const context = useContext(ProductContext);
  if (!context && !options?.optional) throw missingProductProvider('useProduct');
  return (context as unknown) as UseProductState<TProduct, TXp> | null;
}

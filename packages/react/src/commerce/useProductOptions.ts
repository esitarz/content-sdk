/* eslint-disable no-redeclare */
import { useContext } from 'react';
import { CommerceError, Spec, Variant } from '@sitecore-content-sdk/commerce';
import { ProductOptionsContext } from './ProductProvider';
import { ProductHookOptions, missingProductProvider } from './useProduct';

/**
 * Product options (specs and variants) load status.
 * @public
 */
export type ProductOptionsStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * State returned by `useProductOptions`.
 * @public
 */
export interface UseProductOptionsState {
  specs: Spec[];
  variants: Variant[];
  hasVariantSpecs: boolean;
  status: ProductOptionsStatus;
  isLoading: boolean;
  isError: boolean;
  error: CommerceError | null;
  /**
   * Option availability for the current selections, by spec ID then option ID. Lists only
   * variant-defining specs.
   */
  optionAvailability: Record<string, Record<string, boolean>>;
  /**
   * Reloads specs and variants only.
   */
  refetch(): Promise<void>;
}

/**
 * Returns the specs, variants and option availability of the nearest `ProductProvider`.
 * @returns {UseProductOptionsState} options state
 * @throws {Error} outside a `ProductProvider`
 * @public
 */
export function useProductOptions(): UseProductOptionsState;
/**
 * Returns the options state of the nearest `ProductProvider`, or null outside one.
 * @param {object} options hook options
 * @param {true} options.optional return null outside a `ProductProvider`
 * @returns {UseProductOptionsState | null} options state or null
 * @public
 */
export function useProductOptions(options: { optional: true }): UseProductOptionsState | null;
/**
 * Implementation of `useProductOptions`.
 * @param {ProductHookOptions} [options] hook options
 * @returns {UseProductOptionsState | null} options state or null
 */
export function useProductOptions(options?: ProductHookOptions): UseProductOptionsState | null {
  const context = useContext(ProductOptionsContext);
  if (!context && !options?.optional) throw missingProductProvider('useProductOptions');
  return context;
}

import { useCallback, useEffect, useMemo } from 'react';
import {
  AddLineItemResult,
  CommerceError,
  LineItem,
  Order,
  ProductLineItemDraft,
} from '@sitecore-content-sdk/commerce';
import { useCommerceInternal } from './CommerceProvider';

/**
 * Raw cart data loaded from OrderCloud.
 * @public
 */
export interface CartData<
  TOrderXp = Record<string, unknown>,
  TLineItemXp = Record<string, unknown>
> {
  order: Order<TOrderXp>;
  lineItems: LineItem<TLineItemXp>[];
}

/**
 * Why a cart changed independently of a normal mutation.
 * @public
 */
export interface CartReset {
  reason: 'cart-submitted' | 'session-replaced';
}

/**
 * Options for {@link useCart}.
 * @public
 */
export interface UseCartOptions<TCart = CartData> {
  /**
   * @default true
   */
  enabled?: boolean;
  /**
   * Maps raw cart data to a starter-specific view model. Keep this function referentially stable.
   */
  select?: (data: CartData) => TCart;
}

/**
 * Shared cart state returned by {@link useCart}.
 * @public
 */
export interface UseCartState<TCart = CartData> {
  cart: TCart | null;
  data: CartData | null;
  itemCount: number;
  status: 'idle' | 'loading' | 'success' | 'error';
  isLoading: boolean;
  isRefetching: boolean;
  isMutating: boolean;
  error: CommerceError | null;
  cartReset: CartReset | null;
  acknowledgeCartReset(): void;
  addLineItem(
    input: ProductLineItemDraft & { Quantity: number }
  ): Promise<AddLineItemResult>;
  updateLineItem(lineItemId: string, quantity: number): Promise<void>;
  removeLineItem(lineItemId: string): Promise<void>;
  clear(): Promise<void>;
  refetch(): Promise<void>;
}

/**
 * Returns the cart shared by every consumer under the current `CommerceProvider`.
 * @param {UseCartOptions} [options] cart hook options
 * @returns {UseCartState} cart state and mutations
 * @public
 */
export function useCart<TCart = CartData>(
  options: UseCartOptions<TCart> = {}
): UseCartState<TCart> {
  const { enabled = true, select } = options;
  const {
    sessionVersion,
    cart: state,
    loadCart,
    addCartLineItem,
    updateCartLineItem,
    removeCartLineItem,
    clearCart,
    acknowledgeCartReset,
  } = useCommerceInternal();

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    loadCart(false, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [enabled, sessionVersion, loadCart]);

  const refetch = useCallback(() => loadCart(true), [loadCart]);
  const data = state.data;
  const cart = useMemo(
    () => (data ? (select ? select(data) : ((data as unknown) as TCart)) : null),
    [data, select]
  );
  const itemCount =
    data?.lineItems.reduce((total, lineItem) => total + (lineItem.Quantity ?? 0), 0) ?? 0;

  return {
    cart,
    data,
    itemCount,
    status: enabled ? state.status : 'idle',
    isLoading: enabled && state.status === 'loading',
    isRefetching: enabled && state.isRefetching,
    isMutating: state.isMutating,
    error: state.error,
    cartReset: state.reset,
    acknowledgeCartReset,
    addLineItem: addCartLineItem,
    updateLineItem: updateCartLineItem,
    removeLineItem: removeCartLineItem,
    clear: clearCart,
    refetch,
  };
}

import { useCallback, useState } from 'react';
import {
  AddLineItemResult,
  QuantityIssueCode,
  validateQuantity,
} from '@sitecore-content-sdk/commerce';
import { useProduct } from './useProduct';
import { useProductOptions } from './useProductOptions';
import { useProductSelection } from './useProductSelection';
import { useCart } from './useCart';
import { useCommerce } from './CommerceProvider';

/**
 * Adds the selected product configuration and quantity to the shared cart.
 * @returns {object} add-to-cart action and pending/capability state
 * @throws {Error} outside `ProductProvider` or `CommerceProvider`
 * @public
 */
export function useAddToCart(): {
  isAdding: boolean;
  canAdd: boolean;
  addToCart(quantity: number): Promise<
    | { ok: true; result: AddLineItemResult }
    | {
        ok: false;
        reason: 'incomplete' | 'quantity';
        quantityIssue?: { code: QuantityIssueCode };
      }
  >;
} {
  const product = useProduct();
  const options = useProductOptions();
  const selection = useProductSelection();
  const cart = useCart();
  const { isEditing } = useCommerce();
  const [isAdding, setIsAdding] = useState(false);

  const addToCart = useCallback(
    async (quantity: number) => {
      if (!selection.validate()) return { ok: false as const, reason: 'incomplete' as const };
      const draft = selection.getLineItemDraft();
      if (!draft || !product.rawProduct) {
        return { ok: false as const, reason: 'incomplete' as const };
      }
      const quantityIssue = validateQuantity(product.rawProduct, quantity);
      if (quantityIssue) {
        return {
          ok: false as const,
          reason: 'quantity' as const,
          quantityIssue: { code: quantityIssue.code },
        };
      }

      setIsAdding(true);
      try {
        const result = await cart.addLineItem({ ...draft, Quantity: quantity });
        return { ok: true as const, result };
      } finally {
        setIsAdding(false);
      }
    },
    [selection, product.rawProduct, cart]
  );

  return {
    addToCart,
    isAdding,
    canAdd:
      product.isSuccess &&
      options.status === 'success' &&
      selection.isComplete &&
      !isEditing &&
      !cart.isMutating &&
      !isAdding,
  };
}

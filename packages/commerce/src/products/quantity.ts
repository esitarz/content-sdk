import { BuyerProduct } from '../ordercloud-types';

/**
 * Quantity validation issue produced by {@link validateQuantity}.
 * @public
 */
export type QuantityIssueCode =
  | 'quantity-invalid'
  | 'quantity-below-min'
  | 'quantity-above-max'
  | 'quantity-not-allowed'
  | 'quantity-not-multiple';

/**
 * Validates an add-to-cart quantity against OrderCloud product price rules.
 * Inventory availability is intentionally not checked.
 * @param {BuyerProduct} product buyer product
 * @param {number} quantity requested quantity
 * @returns {object | undefined} issue, or undefined when valid
 * @public
 */
export function validateQuantity(
  product: BuyerProduct,
  quantity: number
): { code: QuantityIssueCode; params?: Record<string, number> } | undefined {
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { code: 'quantity-invalid' };
  }

  const schedule = product?.PriceSchedule;
  if (schedule?.MinQuantity !== undefined && quantity < schedule.MinQuantity) {
    return { code: 'quantity-below-min', params: { min: schedule.MinQuantity } };
  }
  if (schedule?.MaxQuantity !== undefined && schedule.MaxQuantity !== null && quantity > schedule.MaxQuantity) {
    return { code: 'quantity-above-max', params: { max: schedule.MaxQuantity } };
  }
  if (
    schedule?.RestrictedQuantity &&
    !(schedule.PriceBreaks ?? []).some((entry) => entry.Quantity === quantity)
  ) {
    return { code: 'quantity-not-allowed', params: { quantity } };
  }
  if (
    product?.QuantityMultiplier !== undefined &&
    product.QuantityMultiplier > 1 &&
    quantity % product.QuantityMultiplier !== 0
  ) {
    return {
      code: 'quantity-not-multiple',
      params: { multiplier: product.QuantityMultiplier },
    };
  }
  return undefined;
}

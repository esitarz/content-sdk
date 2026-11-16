import { BuyerProduct, Spec } from '../ordercloud-types';
import { SpecSelections } from './product-options';

/**
 * Display estimate returned by {@link estimateUnitPrice}.
 * @public
 */
export interface UnitPriceEstimate {
  price: number;
  currency?: string;
  isSale: boolean;
}

/**
 * Estimates the unit price of a product for display: picks the highest price break at or below
 * `quantity`, uses the sale price when the schedule is on sale, then applies selected option
 * markups. OrderCloud computes the authoritative line-item price; do not use this for totals.
 * @param {BuyerProduct} product product with a price schedule
 * @param {object} [options] estimate options
 * @param {number} [options.quantity] quantity (defaults to `MinQuantity`, or 1)
 * @param {Spec[]} [options.specs] product specs, for option markups
 * @param {SpecSelections} [options.selections] current selections, for option markups
 * @returns {UnitPriceEstimate | null} estimate, or null when the product has no price schedule or price breaks
 * @public
 */
export function estimateUnitPrice(
  product: BuyerProduct,
  options: { quantity?: number; specs?: Spec[]; selections?: SpecSelections } = {}
): UnitPriceEstimate | null {
  const schedule = product?.PriceSchedule;
  const breaks = (schedule?.PriceBreaks ?? []).filter(
    (entry) => typeof entry?.Quantity === 'number' && typeof entry?.Price === 'number'
  );
  if (!schedule || !breaks.length) return null;

  const quantity = Math.max(1, options.quantity ?? schedule.MinQuantity ?? 1);
  const sorted = [...breaks].sort((a, b) => a.Quantity - b.Quantity);
  const priceBreak = [...sorted].reverse().find((entry) => entry.Quantity <= quantity) ?? sorted[0];

  const isSale = !!schedule.IsOnSale && typeof priceBreak.SalePrice === 'number';
  const base = isSale ? (priceBreak.SalePrice as number) : priceBreak.Price;
  let price = base;

  for (const spec of options.specs ?? []) {
    const optionId = options.selections?.[spec?.ID]?.optionId;
    const option = optionId ? spec.Options?.find((o) => o.ID === optionId) : undefined;
    const markup = option?.PriceMarkup;
    if (!option || typeof markup !== 'number') continue;

    switch (option.PriceMarkupType) {
      case 'AmountPerQuantity':
        price += markup;
        break;
      case 'AmountTotal':
        price += markup / quantity;
        break;
      case 'Percentage':
        price += (base * markup) / 100;
        break;
      default:
        break;
    }
  }

  const result: UnitPriceEstimate = { price, isSale };
  if (schedule.Currency) result.currency = schedule.Currency;
  return result;
}

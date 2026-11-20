import { expect } from 'chai';
import { BuyerProduct } from '../ordercloud-types';
import { validateQuantity } from './quantity';

const product = (overrides: Partial<BuyerProduct> = {}): BuyerProduct => ({
  ID: 'p1',
  Name: 'Product',
  ...overrides,
});

describe('validateQuantity', () => {
  it('rejects non-positive and fractional quantities', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validateQuantity(product(), quantity)).to.deep.equal({
        code: 'quantity-invalid',
      });
    }
  });

  it('enforces minimum, maximum and restricted quantities', () => {
    expect(
      validateQuantity(
        product({
          PriceSchedule: {
            MinQuantity: 2,
            MaxQuantity: 10,
            RestrictedQuantity: true,
            PriceBreaks: [
              { Quantity: 2, Price: 10 },
              { Quantity: 4, Price: 9 },
            ],
          },
        }),
        1
      )
    ).to.deep.equal({ code: 'quantity-below-min', params: { min: 2 } });

    expect(
      validateQuantity(
        product({ PriceSchedule: { MaxQuantity: 10, PriceBreaks: [] } }),
        11
      )
    ).to.deep.equal({ code: 'quantity-above-max', params: { max: 10 } });

    expect(
      validateQuantity(
        product({
          PriceSchedule: {
            RestrictedQuantity: true,
            PriceBreaks: [
              { Quantity: 2, Price: 10 },
              { Quantity: 4, Price: 9 },
            ],
          },
        }),
        3
      )
    ).to.deep.equal({ code: 'quantity-not-allowed', params: { quantity: 3 } });
  });

  it('enforces quantity multipliers after price rules', () => {
    expect(validateQuantity(product({ QuantityMultiplier: 6 }), 4)).to.deep.equal({
      code: 'quantity-not-multiple',
      params: { multiplier: 6 },
    });
    expect(validateQuantity(product({ QuantityMultiplier: 6 }), 12)).to.equal(undefined);
  });

  it('does not validate inventory or price rules when absent', () => {
    expect(
      validateQuantity(
        product({ Inventory: { QuantityAvailable: 1, Enabled: true } }),
        2
      )
    ).to.equal(undefined);
  });
});

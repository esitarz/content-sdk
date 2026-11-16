import { expect } from 'chai';
import { BuyerProduct, Spec } from '../ordercloud-types';
import { estimateUnitPrice } from './pricing';

const product = (schedule: BuyerProduct['PriceSchedule']): BuyerProduct => ({
  ID: 'p1',
  Name: 'P1',
  PriceSchedule: schedule,
});

const schedule = {
  Currency: 'USD',
  PriceBreaks: [
    { Quantity: 1, Price: 10, SalePrice: 8 },
    { Quantity: 10, Price: 9, SalePrice: 7 },
  ],
};

describe('estimateUnitPrice', () => {
  it('should return null without a price schedule', () => {
    expect(estimateUnitPrice(product(undefined))).to.equal(null);
    expect(estimateUnitPrice(product({ PriceBreaks: [] }))).to.equal(null);
  });

  it('should pick the highest break at or below the quantity', () => {
    expect(estimateUnitPrice(product(schedule))).to.deep.equal({
      price: 10,
      currency: 'USD',
      isSale: false,
    });
    expect(estimateUnitPrice(product(schedule), { quantity: 12 })?.price).to.equal(9);
    expect(estimateUnitPrice(product({ ...schedule, MinQuantity: 10 }))?.price).to.equal(9);
  });

  it('should use the sale price when on sale', () => {
    expect(estimateUnitPrice(product({ ...schedule, IsOnSale: true }), { quantity: 10 })).to.deep.equal(
      { price: 7, currency: 'USD', isSale: true }
    );
  });

  it('should apply each markup type', () => {
    const specs: Spec[] = [
      {
        ID: 'A',
        Name: 'A',
        Options: [
          { ID: 'per', Value: 'per', PriceMarkupType: 'AmountPerQuantity', PriceMarkup: 2 },
          { ID: 'total', Value: 'total', PriceMarkupType: 'AmountTotal', PriceMarkup: 20 },
          { ID: 'pct', Value: 'pct', PriceMarkupType: 'Percentage', PriceMarkup: 50 },
          { ID: 'none', Value: 'none', PriceMarkupType: 'NoMarkup', PriceMarkup: 99 },
        ],
      },
    ];
    const estimate = (optionId: string, quantity = 1) =>
      estimateUnitPrice(product(schedule), { quantity, specs, selections: { A: { optionId } } })
        ?.price;

    expect(estimate('per')).to.equal(12);
    expect(estimate('total', 10)).to.equal(11);
    expect(estimate('pct')).to.equal(15);
    expect(estimate('none')).to.equal(10);
  });
});
